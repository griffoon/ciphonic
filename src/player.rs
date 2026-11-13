//! Audio playback. A worker thread decodes with symphonia and fills a buffer; the cpal output
//! callback (WASAPI on Windows) drains it. Position is counted in output frames, so the progress
//! follows what the sound card actually plays, not what was decoded.

use std::collections::VecDeque;
use std::fs::File;
use std::io::Cursor;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard};
use std::thread;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{Decoder, DecoderOptions};
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::units::Time;

const MIN_SPEED: f32 = 0.5;
const MAX_SPEED: f32 = 2.0;
/// How often the worker asks Windows which output device is the default.
const DEVICE_CHECK: Duration = Duration::from_secs(1);

fn speed(shared: &Shared) -> f32 {
    let speed = f32::from_bits(shared.speed.load(Ordering::Relaxed));
    if speed > 0.0 { speed } else { 1.0 }
}

/// How much decoded audio to keep ahead of the sound card, in seconds.
const BUFFER_SECONDS: f64 = 0.5;

#[derive(Clone)]
pub enum Source {
    File(PathBuf),
    Bytes { data: Vec<u8>, ext: String },
}

enum Cmd {
    Load(Source),
    Seek(f64),
    Stop,
}

/// Mono copy of what the sound card plays, for the visualizer. Capped to the last few frames.
const TAP_CAP: usize = 8192;

#[derive(Default)]
struct Shared {
    buffer: Mutex<VecDeque<f32>>,
    tap: Mutex<VecDeque<f32>>,
    /// Output frames played since the last seek.
    frames: AtomicU64,
    /// Where the last seek (or the start) landed, in milliseconds.
    base_millis: AtomicU64,
    duration_millis: AtomicU64,
    /// Output gain as f32 bits; set to 1.0 at start (the derived default would be silence).
    volume: AtomicU32,
    playing: AtomicBool,
    /// Set when the decoder ran out of packets; playback stops once the buffer drains.
    ended: AtomicBool,
    out_rate: AtomicU32,
    eq: Mutex<crate::eq::Equalizer>,
    /// The current track split into vocal and the rest («голос»), when it has been separated.
    stem: Mutex<Option<Arc<crate::vocals::Stem>>>,
    /// How much vocal to take out, f32 bits: 0 = original.
    vocal_cut: AtomicU32,
    /// Playback rate as f32 bits; set to 1.0 at start. Pitch moves with it (nightcore, slowed).
    speed: AtomicU32,
    /// Reverb amount 0…1 as f32 bits.
    reverb_amount: AtomicU32,
    reverb: Mutex<crate::reverb::Reverb>,
    /// Set by the output stream when its device fails (unplugged); the worker reopens.
    device_lost: AtomicBool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub position: f64,
    pub duration: f64,
    pub playing: bool,
    pub ended: bool,
}

pub struct Player {
    tx: mpsc::Sender<Cmd>,
    shared: Arc<Shared>,
}

impl Player {
    /// Opens the default output device and starts the worker. Fails if there is no usable device.
    pub fn start() -> Result<Self, String> {
        let shared = Arc::new(Shared::default());
        shared.volume.store(1.0f32.to_bits(), Ordering::Relaxed);
        shared.speed.store(1.0f32.to_bits(), Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::channel();
        let worker = Arc::clone(&shared);
        thread::Builder::new()
            .name("volna-audio".into())
            .spawn(move || run(worker, rx, ready_tx))
            .map_err(|e| e.to_string())?;
        ready_rx.recv().map_err(|e| e.to_string())??;
        Ok(Self { tx, shared })
    }

    pub fn load(&self, source: Source) -> Result<(), String> {
        self.tx.send(Cmd::Load(source)).map_err(|e| e.to_string())
    }

    pub fn seek(&self, seconds: f64) -> Result<(), String> {
        self.tx.send(Cmd::Seek(seconds.max(0.0))).map_err(|e| e.to_string())
    }

    pub fn stop(&self) -> Result<(), String> {
        self.tx.send(Cmd::Stop).map_err(|e| e.to_string())
    }

    pub fn set_playing(&self, playing: bool) {
        self.shared.playing.store(playing, Ordering::Relaxed);
    }

    /// 0…1, applied in the output callback.
    pub fn set_volume(&self, volume: f32) {
        self.shared.volume.store(volume.clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
    }

    /// Equalizer gains in dB, one per band of `eq::FREQUENCIES`.
    pub fn set_eq(&self, gains: &[f32]) {
        lock(&self.shared.eq).set_gains(gains);
    }

    /// Speed with pitch: 1.25 = nightcore, 0.8 = slowed. Restarts the buffer at the current
    /// position so the change is heard at once.
    pub fn set_speed(&self, speed: f32) -> Result<(), String> {
        let speed = if speed.is_finite() { speed.clamp(MIN_SPEED, MAX_SPEED) } else { 1.0 };
        let position = self.status().position;
        self.shared.speed.store(speed.to_bits(), Ordering::Relaxed);
        self.seek(position)
    }

    pub fn set_reverb(&self, amount: f32) {
        let amount = if amount.is_finite() { amount.clamp(0.0, 1.0) } else { 0.0 };
        self.shared.reverb_amount.store(amount.to_bits(), Ordering::Relaxed);
    }

    pub fn set_stem(&self, stem: Option<Arc<crate::vocals::Stem>>) {
        *lock(&self.shared.stem) = stem;
    }

    pub fn set_vocal_cut(&self, cut: f32) {
        self.shared.vocal_cut.store(cut.clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
    }

    pub fn is_playing(&self) -> bool {
        self.shared.playing.load(Ordering::Relaxed)
    }

    pub fn sample_rate(&self) -> u32 {
        self.shared.out_rate.load(Ordering::Relaxed)
    }

    /// The last `len` mono samples that reached the sound card, zero-padded at the front.
    pub fn tap_window(&self, len: usize) -> Vec<f32> {
        let tap = lock(&self.shared.tap);
        let mut window = vec![0.0; len];
        let take = tap.len().min(len);
        for (dst, src) in window[len - take..].iter_mut().zip(tap.iter().skip(tap.len() - take)) {
            *dst = *src;
        }
        window
    }

    pub fn status(&self) -> Status {
        let rate = f64::from(self.shared.out_rate.load(Ordering::Relaxed).max(1));
        let frames = self.shared.frames.load(Ordering::Relaxed) as f64;
        let base = self.shared.base_millis.load(Ordering::Relaxed) as f64 / 1000.0;
        Status {
            position: base + frames * f64::from(speed(&self.shared)) / rate,
            duration: self.shared.duration_millis.load(Ordering::Relaxed) as f64 / 1000.0,
            playing: self.shared.playing.load(Ordering::Relaxed),
            ended: self.shared.ended.load(Ordering::Relaxed),
        }
    }
}

fn run(shared: Arc<Shared>, rx: mpsc::Receiver<Cmd>, ready: mpsc::Sender<Result<(), String>>) {
    let (mut output, mut out_rate, mut out_ch) = match open_output(&shared) {
        Ok((stream, rate, channels)) => {
            let _ = ready.send(Ok(()));
            (Some(stream), rate, channels)
        }
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };
    let mut device = default_device_name();
    let mut last_check = std::time::Instant::now();
    let mut session: Option<Session> = None;

    loop {
        if last_check.elapsed() >= DEVICE_CHECK {
            last_check = std::time::Instant::now();
            let now = default_device_name();
            if now != device || shared.device_lost.load(Ordering::Relaxed) {
                // Keep the place in the track: the new device may run at another rate.
                let position = base_position(&shared);
                // Close the old stream first: some drivers refuse a second one on the device.
                output = None;
                match open_output(&shared) {
                    Ok((stream, rate, channels)) => {
                        shared.device_lost.store(false, Ordering::Relaxed);
                        device = now;
                        output = Some(stream);
                        out_rate = rate;
                        out_ch = channels;
                        if let Some(current) = session.as_mut() {
                            current.out_rate = rate;
                            current.out_ch = channels;
                            if current.seek(position).is_ok() {
                                reset(&shared, position);
                            }
                        }
                    }
                    // No device right now (all unplugged): the next check tries again.
                    Err(e) => eprintln!("[audio] reopen: {e}"),
                }
            }
        }
        if output.is_none() {
            thread::sleep(Duration::from_millis(50));
        }
        match rx.try_recv() {
            Ok(cmd) => apply(cmd, &shared, &mut session, out_rate, out_ch),
            Err(mpsc::TryRecvError::Disconnected) => break,
            Err(mpsc::TryRecvError::Empty) => {}
        }
        let mut worked = false;
        let want_more = shared.playing.load(Ordering::Relaxed)
            && !shared.ended.load(Ordering::Relaxed)
            && buffered(&shared) < (BUFFER_SECONDS * f64::from(out_rate)) as usize * out_ch;
        if let (true, Some(current)) = (want_more, session.as_mut()) {
            worked = true;
            if !current.decode_step(&shared) {
                shared.ended.store(true, Ordering::Relaxed);
            }
        }
        if !worked {
            thread::sleep(Duration::from_millis(5));
        }
    }
}

fn apply(cmd: Cmd, shared: &Shared, session: &mut Option<Session>, out_rate: u32, out_ch: usize) {
    match cmd {
        Cmd::Load(source) => match Session::open(source, out_rate, out_ch) {
            Ok(opened) => {
                shared
                    .duration_millis
                    .store((opened.duration * 1000.0) as u64, Ordering::Relaxed);
                reset(shared, 0.0);
                shared.playing.store(true, Ordering::Relaxed);
                *session = Some(opened);
            }
            Err(e) => {
                eprintln!("[audio] {e}");
                *session = None;
                reset(shared, 0.0);
                shared.ended.store(true, Ordering::Relaxed);
                shared.playing.store(false, Ordering::Relaxed);
            }
        },
        Cmd::Seek(seconds) => {
            if let Some(current) = session.as_mut() {
                match current.seek(seconds) {
                    Ok(()) => reset(shared, seconds),
                    Err(e) => eprintln!("[audio] seek: {e}"),
                }
            }
        }
        Cmd::Stop => {
            *session = None;
            reset(shared, 0.0);
            shared.ended.store(true, Ordering::Relaxed);
            shared.playing.store(false, Ordering::Relaxed);
        }
    }
}

/// Clears queued audio and moves the position counter to `at_seconds`.
fn reset(shared: &Shared, at_seconds: f64) {
    lock(&shared.buffer).clear();
    shared.frames.store(0, Ordering::Relaxed);
    shared.base_millis.store((at_seconds * 1000.0) as u64, Ordering::Relaxed);
    shared.ended.store(false, Ordering::Relaxed);
}

/// Where playback is, in track seconds.
fn base_position(shared: &Shared) -> f64 {
    let rate = f64::from(shared.out_rate.load(Ordering::Relaxed).max(1));
    shared.base_millis.load(Ordering::Relaxed) as f64 / 1000.0
        + shared.frames.load(Ordering::Relaxed) as f64 * f64::from(speed(shared)) / rate
}

fn default_device_name() -> Option<String> {
    cpal::default_host().default_output_device().and_then(|d| d.name().ok())
}

fn buffered(shared: &Shared) -> usize {
    lock(&shared.buffer).len()
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn open_output(shared: &Arc<Shared>) -> Result<(cpal::Stream, u32, usize), String> {
    let device = cpal::default_host()
        .default_output_device()
        .ok_or("Нет устройства вывода звука")?;
    let supported = device.default_output_config().map_err(|e| e.to_string())?;
    if supported.sample_format() != cpal::SampleFormat::F32 {
        return Err("Устройство вывода работает не во float32".into());
    }
    let config: cpal::StreamConfig = supported.into();
    let rate = config.sample_rate.0;
    let channels = usize::from(config.channels);
    shared.out_rate.store(rate, Ordering::Relaxed);

    let callback_shared = Arc::clone(shared);
    let error_shared = Arc::clone(shared);
    let stream = device
        .build_output_stream(
            &config,
            move |data: &mut [f32], _| fill(data, &callback_shared, channels),
            move |e| {
                eprintln!("[audio] output: {e}");
                error_shared.device_lost.store(true, Ordering::Relaxed);
            },
            None,
        )
        .map_err(|e| e.to_string())?;
    stream.play().map_err(|e| e.to_string())?;
    Ok((stream, rate, channels))
}

/// Runs on the audio thread: takes what the decoder queued and never blocks for long.
fn fill(data: &mut [f32], shared: &Shared, channels: usize) {
    let playing = shared.playing.load(Ordering::Relaxed);
    // Squared so the slider feels even to the ear.
    let gain = f32::from_bits(shared.volume.load(Ordering::Relaxed)).powi(2);
    // «Голос»: where the stem is ready, play its `mix − cut · vocal` instead of the decode, at
    // the same position. try_lock: the audio thread never waits for the separation job.
    let cut = f32::from_bits(shared.vocal_cut.load(Ordering::Relaxed));
    let stem = if cut > 0.001 { shared.stem.try_lock().ok().and_then(|s| s.clone()) } else { None };
    let out_rate = f64::from(shared.out_rate.load(Ordering::Relaxed).max(1));
    let played = base_position(shared);
    let step = stem.as_ref().map_or(0.0, |s| f64::from(s.rate) / out_rate * f64::from(speed(shared)));
    let mut stem_pos = played * stem.as_ref().map_or(0.0, |s| f64::from(s.rate));

    let mut buffer = lock(&shared.buffer);
    let mut frames = 0u64;
    for frame in data.chunks_mut(channels) {
        if playing && buffer.len() >= channels {
            for (c, sample) in frame.iter_mut().enumerate() {
                let decoded = buffer.pop_front().unwrap_or(0.0);
                let value = stem.as_ref().and_then(|s| s.sample(c, stem_pos, cut)).unwrap_or(decoded);
                *sample = value * gain;
            }
            stem_pos += step;
            frames += 1;
        } else {
            frame.fill(0.0);
        }
    }
    drop(buffer);
    {
        let mut eq = lock(&shared.eq);
        eq.set_rate(shared.out_rate.load(Ordering::Relaxed));
        eq.process(data, channels);
    }
    {
        let amount = f32::from_bits(shared.reverb_amount.load(Ordering::Relaxed));
        lock(&shared.reverb).process(data, channels, shared.out_rate.load(Ordering::Relaxed), amount);
    }
    if frames > 0 {
        shared.frames.fetch_add(frames, Ordering::Relaxed);
    }
    {
        // The visualizer hears the music before the volume slider, like on iOS.
        let undo_gain = if gain > 1e-4 { 1.0 / gain } else { 0.0 };
        let mut tap = lock(&shared.tap);
        for frame in data.chunks(channels) {
            tap.push_back(frame.iter().sum::<f32>() / channels as f32 * undo_gain);
        }
        while tap.len() > TAP_CAP {
            tap.pop_front();
        }
    }
    if playing && shared.ended.load(Ordering::Relaxed) && buffered(shared) == 0 {
        shared.playing.store(false, Ordering::Relaxed);
    }
}

/// One open track: format reader, decoder and the resampler to the output rate.
struct Session {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn Decoder>,
    track_id: u32,
    duration: f64,
    out_rate: u32,
    out_ch: usize,
    resampler: Linear,
}

impl Session {
    fn open(source: Source, out_rate: u32, out_ch: usize) -> Result<Self, String> {
        let (stream, hint) = match source {
            Source::File(path) => {
                let mut hint = Hint::new();
                if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                    hint.with_extension(ext);
                }
                let file = File::open(&path).map_err(|e| e.to_string())?;
                (MediaSourceStream::new(Box::new(file), Default::default()), hint)
            }
            Source::Bytes { data, ext } => {
                let mut hint = Hint::new();
                hint.with_extension(&ext);
                (MediaSourceStream::new(Box::new(Cursor::new(data)), Default::default()), hint)
            }
        };
        let probed = symphonia::default::get_probe()
            .format(&hint, stream, &FormatOptions::default(), &MetadataOptions::default())
            .map_err(|e| e.to_string())?;
        let format = probed.format;
        let track = format.default_track().ok_or("В файле нет аудиодорожки")?;
        let track_id = track.id;
        let params = track.codec_params.clone();
        let decoder = symphonia::default::get_codecs()
            .make(&params, &DecoderOptions::default())
            .map_err(|e| e.to_string())?;
        let in_rate = params.sample_rate.unwrap_or(out_rate);
        let duration = params.n_frames.map_or(0.0, |n| n as f64 / f64::from(in_rate));
        Ok(Self {
            format,
            decoder,
            track_id,
            duration,
            out_rate,
            out_ch,
            resampler: Linear::new(f64::from(in_rate) / f64::from(out_rate)),
        })
    }

    fn seek(&mut self, seconds: f64) -> Result<(), String> {
        self.format
            .seek(
                SeekMode::Accurate,
                SeekTo::Time {
                    time: Time::from(seconds),
                    track_id: Some(self.track_id),
                },
            )
            .map_err(|e| e.to_string())?;
        self.decoder.reset();
        self.resampler.reset();
        Ok(())
    }

    /// Decodes one packet into the shared buffer. Returns false at the end of the track.
    fn decode_step(&mut self, shared: &Shared) -> bool {
        let packet = match self.format.next_packet() {
            Ok(packet) => packet,
            Err(_) => return false,
        };
        if packet.track_id() != self.track_id {
            return true;
        }
        let decoded = match self.decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(SymError::DecodeError(_)) => return true,
            Err(_) => return false,
        };
        let spec = *decoded.spec();
        let mut interleaved = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
        interleaved.copy_interleaved_ref(decoded);
        let in_ch = spec.channels.count().max(1);
        self.resampler.step = f64::from(spec.rate) / f64::from(self.out_rate) * f64::from(speed(shared));

        let mut resampled = Vec::new();
        self.resampler.process(interleaved.samples(), in_ch, &mut resampled);
        let mut mapped = Vec::with_capacity(resampled.len() / in_ch * self.out_ch);
        for frame in resampled.chunks(in_ch) {
            for c in 0..self.out_ch {
                mapped.push(frame[c.min(in_ch - 1)]);
            }
        }
        lock(&shared.buffer).extend(mapped);
        true
    }
}

/// Linear-interpolation resampler, carrying one frame across chunks. Good enough for a first
/// version; a band-limited resampler is on the list for the polish pass.
struct Linear {
    /// Input frames per output frame.
    step: f64,
    /// Read position relative to the carried frame (index 0) plus the current chunk.
    pos: f64,
    prev: Vec<f32>,
}

impl Linear {
    fn new(step: f64) -> Self {
        Self { step, pos: 0.0, prev: Vec::new() }
    }

    fn reset(&mut self) {
        self.pos = 0.0;
        self.prev.iter_mut().for_each(|v| *v = 0.0);
    }

    fn process(&mut self, input: &[f32], channels: usize, out: &mut Vec<f32>) {
        let frames = input.len() / channels;
        if frames == 0 {
            return;
        }
        self.prev.resize(channels, 0.0);
        let prev = self.prev.clone();
        // Frame 0 is the carried frame from the previous chunk, frame i is input frame i-1.
        let at = |i: usize, c: usize| if i == 0 { prev[c] } else { input[(i - 1) * channels + c] };
        let total = (frames + 1) as f64;
        while self.pos + 1.0 < total {
            let k = self.pos.floor() as usize;
            let f = (self.pos - k as f64) as f32;
            for c in 0..channels {
                out.push(at(k, c) * (1.0 - f) + at(k + 1, c) * f);
            }
            self.pos += self.step;
        }
        self.pos -= frames as f64;
        self.prev.copy_from_slice(&input[(frames - 1) * channels..frames * channels]);
    }
}
