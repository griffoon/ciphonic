//! «Голос», ported from VocalSeparator.swift: the UVR MDX-Net «Kim Vocal 2» model splits the
//! current track into vocals and the rest, ahead of the playhead, and the player swaps in
//! `mix − cut · vocal` wherever the stem is ready. The model and ONNX Runtime are downloaded
//! once, on request, into the app's data folder.

use std::fs;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;

use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};
use serde::Serialize;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use tauri::{AppHandle, Emitter, Manager};

use crate::player::{Player, Source};

const RUNTIME_URL: &str =
    "https://github.com/microsoft/onnxruntime/releases/download/v1.20.1/onnxruntime-win-x64-1.20.1.zip";
const RUNTIME_ENTRY: &str = "onnxruntime-win-x64-1.20.1/lib/onnxruntime.dll";
const MODEL_URL: &str =
    "https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/Kim_Vocal_2.onnx";
/// Sanity floor for the downloaded files (the real ones are ~11 MB and ~66 MB).
const MIN_RUNTIME_BYTES: usize = 5_000_000;
const MIN_MODEL_BYTES: usize = 50_000_000;

// UVR MDX-Net "Kim Vocal 2": n_fft 7680, hop 1024, the lowest 3072 bins, 256 frames per call.
const RATE: u32 = 44_100;
const FFT_SIZE: usize = 7680;
const HALF: usize = FFT_SIZE / 2;
const HOP: usize = 1024;
const MODEL_BINS: usize = 3072;
const FRAMES: usize = 256;
/// Frames dropped at each chunk edge so the model always has context on both sides.
const EDGE: usize = 16;
/// UVR's per-model gain correction for the vocal estimate.
const COMPENSATE: f32 = 1.009;
/// Longest track kept in memory (minutes): beyond that the stem would eat too much RAM.
const MAX_MINUTES: f64 = 15.0;

// Mask shaping, as on iOS: push the conservative estimate up a little and let it linger after
// the voice so reverb tails go with it, unless a new note starts in that bin.
const OVER_SUBTRACT: f32 = 1.12;
const LIFT: f32 = 0.75;
const TAIL_SECONDS: f32 = 0.35;
const TAIL_AMOUNT: f32 = 0.75;
const ONSET_RATIO: f32 = 1.6;

/// One track decoded at 44.1 kHz stereo and its vocal, filled in ahead of the playhead.
/// The job is the only writer and only writes at or past `processed`; the audio thread only
/// reads below it, so plain atomics are enough and the audio callback never waits.
pub struct Stem {
    pub rate: u32,
    mix: [Vec<i16>; 2],
    vocal: [Vec<AtomicU32>; 2],
    processed: AtomicUsize,
}

impl Stem {
    fn new(mix: [Vec<i16>; 2]) -> Self {
        let len = mix[0].len();
        let make = || (0..len).map(|_| AtomicU32::new(0)).collect::<Vec<_>>();
        Self { rate: RATE, vocal: [make(), make()], mix, processed: AtomicUsize::new(0) }
    }

    pub fn len(&self) -> usize {
        self.mix[0].len()
    }

    fn mix_at(&self, channel: usize, index: usize) -> f32 {
        self.mix[channel].get(index).map_or(0.0, |&s| f32::from(s) / 32768.0)
    }

    fn vocal_at(&self, channel: usize, index: usize) -> f32 {
        self.vocal[channel].get(index).map_or(0.0, |v| f32::from_bits(v.load(Ordering::Relaxed)))
    }

    fn add_vocal(&self, channel: usize, index: usize, value: f32) {
        if let Some(cell) = self.vocal[channel].get(index) {
            let sum = f32::from_bits(cell.load(Ordering::Relaxed)) + value;
            cell.store(sum.to_bits(), Ordering::Relaxed);
        }
    }

    /// `mix − cut · vocal` at a fractional position, if the vocal is ready there.
    pub fn sample(&self, channel: usize, position: f64, cut: f32) -> Option<f32> {
        if position < 0.0 {
            return None;
        }
        let index = position as usize;
        if index + 1 >= self.processed.load(Ordering::Acquire) {
            return None;
        }
        let frac = (position - index as f64) as f32;
        let c = channel.min(1);
        let lerp = |a: f32, b: f32| a + (b - a) * frac;
        let mix = lerp(self.mix_at(c, index), self.mix_at(c, index + 1));
        let vocal = lerp(self.vocal_at(c, index), self.vocal_at(c, index + 1));
        Some(mix - cut * vocal)
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VocalsState {
    /// The model and runtime are on disk.
    pub installed: bool,
    /// idle | installing | working | ready | failed
    pub phase: String,
    pub progress: f64,
    pub message: String,
    /// Seconds of audio separated per second of work (below 1 = slower than playback).
    pub speed: f64,
}

/// What the commands share: the current track's audio and the running job.
#[derive(Default)]
pub struct Vocals {
    current: Mutex<Option<Source>>,
    /// Bumped on every track change; a job from an older track stops and publishes nothing.
    generation: AtomicU64,
    running: AtomicBool,
    installing: AtomicBool,
    cut: AtomicU32,
    state: Mutex<Option<VocalsState>>,
}

fn dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("vocals");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn installed(app: &AppHandle) -> bool {
    dir(app).is_ok_and(|d| d.join("onnxruntime.dll").is_file() && d.join("Kim_Vocal_2.onnx").is_file())
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn publish(app: &AppHandle, phase: &str, progress: f64, message: &str, speed: f64) {
    let state = VocalsState {
        installed: installed(app),
        phase: phase.to_owned(),
        progress,
        message: message.to_owned(),
        speed,
    };
    *lock(&app.state::<Vocals>().state) = Some(state.clone());
    let _ = app.emit("vocals", state);
}

#[tauri::command]
pub fn vocals_state(app: AppHandle) -> VocalsState {
    lock(&app.state::<Vocals>().state).clone().unwrap_or(VocalsState {
        installed: installed(&app),
        phase: "idle".into(),
        progress: 0.0,
        message: String::new(),
        speed: 0.0,
    })
}

/// Downloads ONNX Runtime and the model (about 80 MB together), with progress events.
#[tauri::command]
pub async fn vocals_install(app: AppHandle) -> Result<(), String> {
    let vocals = app.state::<Vocals>();
    if installed(&app) || vocals.installing.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let result = install(&app).await;
    app.state::<Vocals>().installing.store(false, Ordering::SeqCst);
    match &result {
        Ok(()) => {
            publish(&app, "idle", 0.0, "", 0.0);
            start_if_needed(&app);
        }
        Err(e) => publish(&app, "failed", 0.0, e, 0.0),
    }
    result
}

async fn install(app: &AppHandle) -> Result<(), String> {
    let dir = dir(app)?;
    let zip = download(app, RUNTIME_URL, 0.0, 0.5).await?;
    let dll = extract(&zip, RUNTIME_ENTRY)?;
    if dll.len() < MIN_RUNTIME_BYTES {
        return Err("ONNX Runtime скачался не целиком".into());
    }
    let model = download(app, MODEL_URL, 0.5, 1.0).await?;
    if model.len() < MIN_MODEL_BYTES {
        return Err("модель скачалась не целиком".into());
    }
    write_atomic(&dir.join("onnxruntime.dll"), &dll)?;
    write_atomic(&dir.join("Kim_Vocal_2.onnx"), &model)?;
    Ok(())
}

async fn download(app: &AppHandle, url: &str, from: f64, to: f64) -> Result<Vec<u8>, String> {
    let mut response = reqwest::get(url).await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("загрузка: HTTP {}", response.status()));
    }
    let total = response.content_length().unwrap_or(0) as f64;
    let mut data = Vec::with_capacity(total as usize);
    let mut last = 0.0;
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        data.extend_from_slice(&chunk);
        if total > 0.0 {
            let share = from + (to - from) * data.len() as f64 / total;
            if share - last > 0.01 {
                last = share;
                publish(app, "installing", share, "скачиваю модель", 0.0);
            }
        }
    }
    Ok(data)
}

fn extract(zip: &[u8], entry: &str) -> Result<Vec<u8>, String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(zip)).map_err(|e| e.to_string())?;
    let mut file = archive.by_name(entry).map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(file.size() as usize);
    file.read_to_end(&mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

fn write_atomic(path: &Path, data: &[u8]) -> Result<(), String> {
    let part = path.with_extension("part");
    fs::write(&part, data).map_err(|e| e.to_string())?;
    fs::rename(&part, path).map_err(|e| e.to_string())
}

/// How much of the vocal to take out: 0 = original, 1 = karaoke.
#[tauri::command]
pub fn set_vocal_cut(app: AppHandle, cut: f32) {
    let cut = if cut.is_finite() { cut.clamp(0.0, 1.0) } else { 0.0 };
    app.state::<Vocals>().cut.store(cut.to_bits(), Ordering::Relaxed);
    app.state::<Player>().set_vocal_cut(cut);
    start_if_needed(&app);
}

/// The player loaded a new track: drop the old stem, separate the new one if «голос» is on.
pub fn track_changed(app: &AppHandle, source: Source) {
    let vocals = app.state::<Vocals>();
    {
        // Same lock as the job's publish, so an old stem can never land on the new track.
        let mut current = lock(&vocals.current);
        *current = Some(source);
        vocals.generation.fetch_add(1, Ordering::SeqCst);
        app.state::<Player>().set_stem(None);
    }
    publish(app, "idle", 0.0, "", 0.0);
    start_if_needed(app);
}

fn start_if_needed(app: &AppHandle) {
    let vocals = app.state::<Vocals>();
    let cut = f32::from_bits(vocals.cut.load(Ordering::Relaxed));
    if cut <= 0.001 || !installed(app) || vocals.running.load(Ordering::SeqCst) {
        return;
    }
    let Some(source) = lock(&vocals.current).clone() else { return };
    let phase = lock(&vocals.state).as_ref().map(|s| s.phase.clone()).unwrap_or_default();
    if phase == "ready" || phase == "working" || phase == "failed" {
        return;
    }
    vocals.running.store(true, Ordering::SeqCst);
    let generation = vocals.generation.load(Ordering::SeqCst);
    let app = app.clone();
    thread::spawn(move || {
        let result = separate(&app, source, generation);
        let vocals = app.state::<Vocals>();
        vocals.running.store(false, Ordering::SeqCst);
        let current = vocals.generation.load(Ordering::SeqCst) == generation;
        match result {
            Ok(()) if current => {}
            Err(e) if current => publish(&app, "failed", 0.0, &e, 0.0),
            // The track changed meanwhile: start over on the new one.
            _ => start_if_needed(&app),
        }
    });
}

// ---------- the model ----------

struct Model {
    session: Mutex<ort::session::Session>,
    input: String,
}

static MODEL: OnceLock<Result<Model, String>> = OnceLock::new();

fn model(app: &AppHandle) -> Result<&'static Model, String> {
    MODEL
        .get_or_init(|| {
            let dir = dir(app)?;
            let environment = ort::init_from(dir.join("onnxruntime.dll"))
                .map_err(|e| format!("ONNX Runtime: {e}"))?
                .build()
                .map_err(|e| format!("ONNX Runtime: {e}"))?;
            let threads = thread::available_parallelism().map_or(2, |n| n.get().saturating_sub(1).max(1));
            let mut builder = ort::session::Session::builder(&environment)
                .map_err(|e| e.to_string())?
                .with_intra_threads(threads)
                .map_err(|e| e.to_string())?;
            let session = builder.commit_from_file(dir.join("Kim_Vocal_2.onnx")).map_err(|e| format!("модель: {e}"))?;
            let input = session.inputs().first().map(|i| i.name().to_owned()).unwrap_or_else(|| "input".into());
            Ok(Model { session: Mutex::new(session), input })
        })
        .as_ref()
        .map_err(Clone::clone)
}

impl Model {
    /// [1, 4, 3072, 256] in, the vocal spectrum in the same layout out.
    fn run(&self, input: Vec<f32>) -> Result<Vec<f32>, String> {
        let tensor = ort::value::Tensor::from_array(([1usize, 4, MODEL_BINS, FRAMES], input)).map_err(|e| e.to_string())?;
        let mut session = lock(&self.session);
        let outputs = session
            .run(ort::inputs![self.input.as_str() => tensor])
            .map_err(|e| format!("модель: {e}"))?;
        let (_, data) = outputs[0].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
        if data.len() != 4 * MODEL_BINS * FRAMES {
            return Err("модель вернула не тот размер".into());
        }
        Ok(data.to_vec())
    }
}

// ---------- the job ----------

fn separate(app: &AppHandle, source: Source, generation: u64) -> Result<(), String> {
    let vocals = app.state::<Vocals>();
    let alive = || vocals.generation.load(Ordering::SeqCst) == generation;
    publish(app, "working", 0.0, "готовлю трек", 0.0);
    let model = model(app)?;
    let mix = decode(source)?;
    if !alive() {
        return Ok(());
    }
    let stem = Arc::new(Stem::new(mix));
    {
        let _current = lock(&vocals.current);
        if !alive() {
            return Ok(());
        }
        app.state::<Player>().set_stem(Some(stem.clone()));
    }

    let mut engine = Engine::new();
    let total = stem.len();
    let total_frames = (total + FFT_SIZE) / HOP;
    let started = std::time::Instant::now();
    let mut chunk_start = 0;
    loop {
        if !alive() {
            return Ok(());
        }
        let count = FRAMES.min(total_frames.saturating_sub(chunk_start));
        if count == 0 {
            break;
        }
        let is_last = chunk_start + FRAMES >= total_frames;
        let lo = if chunk_start == 0 { 0 } else { EDGE };
        let hi = if is_last { count } else { FRAMES - EDGE };
        engine.process(model, &stem, chunk_start, count, lo..hi)?;
        let done = if is_last { total } else { ((chunk_start + hi) * HOP).min(total) };
        stem.processed.store(done, Ordering::Release);
        let seconds = done as f64 / f64::from(RATE);
        let speed = seconds / started.elapsed().as_secs_f64().max(0.001);
        if is_last {
            publish(app, "ready", 1.0, "", speed);
            break;
        }
        publish(app, "working", (done as f64 / total as f64).min(0.99), "", speed);
        chunk_start += hi - EDGE;
    }
    Ok(())
}

/// The whole track as 44.1 kHz stereo, 16-bit (half the memory of floats, inaudible here).
fn decode(source: Source) -> Result<[Vec<i16>; 2], String> {
    let mut hint = Hint::new();
    let stream: Box<dyn symphonia::core::io::MediaSource> = match source {
        Source::File(path) => {
            if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                hint.with_extension(ext);
            }
            Box::new(fs::File::open(&path).map_err(|e| e.to_string())?)
        }
        Source::Bytes { data, ext } => {
            hint.with_extension(&ext);
            Box::new(Cursor::new(data))
        }
    };
    let mss = MediaSourceStream::new(stream, Default::default());
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| e.to_string())?;
    let mut format = probed.format;
    let track = format.default_track().ok_or("в файле нет звука")?;
    let track_id = track.id;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| e.to_string())?;

    let mut left = Vec::new();
    let mut right = Vec::new();
    let mut rate = RATE;
    let limit = (MAX_MINUTES * 60.0 * f64::from(RATE)) as usize;
    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymError::IoError(_)) | Err(SymError::ResetRequired) => break,
            Err(e) => return Err(e.to_string()),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(SymError::DecodeError(_)) => continue,
            Err(e) => return Err(e.to_string()),
        };
        let spec = *decoded.spec();
        rate = spec.rate;
        let channels = spec.channels.count().max(1);
        let mut buffer = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
        buffer.copy_interleaved_ref(decoded);
        for frame in buffer.samples().chunks(channels) {
            left.push(frame[0]);
            right.push(frame[1.min(channels - 1)]);
        }
        if left.len() > limit * 2 {
            return Err("трек слишком длинный для разделения".into());
        }
    }
    if left.is_empty() {
        return Err("в файле нет звука".into());
    }
    let to_i16 = |v: Vec<f32>| -> Vec<i16> {
        let v = resample(&v, rate, RATE);
        v.iter().map(|s| (s.clamp(-1.0, 1.0) * 32767.0) as i16).collect()
    };
    Ok([to_i16(left), to_i16(right)])
}

/// Linear resampling to the model's rate; a no-op at 44.1 kHz, which is most of the catalogue.
fn resample(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || from == 0 {
        return input.to_vec();
    }
    let step = f64::from(from) / f64::from(to);
    let len = (input.len() as f64 * f64::from(to) / f64::from(from)).round() as usize;
    (0..len)
        .map(|i| {
            let pos = i as f64 * step;
            let index = pos as usize;
            let frac = (pos - index as f64) as f32;
            let a = input[index];
            let b = *input.get(index + 1).unwrap_or(&a);
            a + (b - a) * frac
        })
        .collect()
}

/// STFT → model (vocal spectrum) → shaped vocal mask → masked inverse STFT, overlap-added.
struct Engine {
    forward: Arc<dyn Fft<f32>>,
    inverse: Arc<dyn Fft<f32>>,
    window: Vec<f32>,
    /// Synthesis window already divided by the overlap sum of window², per position.
    synthesis: Vec<f32>,
    tail_decay: f32,
    /// Spectra per channel: frame-major, HALF bins each.
    spectra: [Vec<Complex<f32>>; 2],
    hold: [Vec<f32>; 2],
    last_level: [Vec<f32>; 2],
    scratch: Vec<Complex<f32>>,
}

impl Engine {
    fn new() -> Self {
        let mut planner = FftPlanner::new();
        // Periodic Hann, as torch.hann_window(periodic=True) used in training.
        let window: Vec<f32> = (0..FFT_SIZE)
            .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / FFT_SIZE as f32).cos())
            .collect();
        let mut overlap = vec![0.0f32; HOP];
        for (i, w) in window.iter().enumerate() {
            overlap[i % HOP] += w * w;
        }
        let synthesis = window.iter().enumerate().map(|(i, w)| w / overlap[i % HOP].max(1e-6)).collect();
        Self {
            forward: planner.plan_fft_forward(FFT_SIZE),
            inverse: planner.plan_fft_inverse(FFT_SIZE),
            window,
            synthesis,
            tail_decay: (-(HOP as f32) / (RATE as f32 * TAIL_SECONDS)).exp(),
            spectra: [vec![Complex::default(); FRAMES * HALF], vec![Complex::default(); FRAMES * HALF]],
            hold: [vec![0.0; MODEL_BINS], vec![0.0; MODEL_BINS]],
            last_level: [vec![0.0; MODEL_BINS], vec![0.0; MODEL_BINS]],
            scratch: vec![Complex::default(); FFT_SIZE],
        }
    }

    fn process(&mut self, model: &Model, stem: &Stem, start_frame: usize, count: usize, keep: std::ops::Range<usize>) -> Result<(), String> {
        let origin = start_frame * HOP;
        let mut input = vec![0.0f32; 4 * MODEL_BINS * FRAMES];
        let at = |ch: usize, bin: usize, frame: usize| (ch * MODEL_BINS + bin) * FRAMES + frame;
        for c in 0..2 {
            for f in 0..count {
                let start = origin + f * HOP;
                for (i, slot) in self.scratch.iter_mut().enumerate() {
                    *slot = Complex::new(stem.mix_at(c, start + i) * self.window[i], 0.0);
                }
                self.forward.process(&mut self.scratch);
                self.spectra[c][f * HALF..(f + 1) * HALF].copy_from_slice(&self.scratch[..HALF]);
                // UVR zeroes the three lowest bins before running the model.
                for b in 3..MODEL_BINS {
                    input[at(2 * c, b, f)] = self.scratch[b].re;
                    input[at(2 * c + 1, b, f)] = self.scratch[b].im;
                }
            }
        }
        let vocal = model.run(input)?;

        for c in 0..2 {
            for f in keep.clone() {
                for b in 0..HALF {
                    let mix = self.spectra[c][f * HALF + b];
                    let mask = if b < MODEL_BINS {
                        let v = Complex::new(vocal[at(2 * c, b, f)], vocal[at(2 * c + 1, b, f)]) * COMPENSATE;
                        let level = mix.norm();
                        let ratio = v.norm() / (level + 1e-9);
                        // A non-finite model value means "don't know": leave the bin alone.
                        let estimate = if ratio.is_finite() { ratio.min(1.0) } else { 0.0 };
                        self.shape(estimate, level, c, b)
                    } else {
                        0.0
                    };
                    self.scratch[b] = if b == 0 { Complex::new(mix.re * mask, 0.0) } else { mix * mask };
                }
                // Real signal: mirror the spectrum; the Nyquist bin stays empty.
                self.scratch[HALF] = Complex::default();
                for b in 1..HALF {
                    self.scratch[FFT_SIZE - b] = self.scratch[b].conj();
                }
                self.inverse.process(&mut self.scratch);
                let base = (start_frame + f) * HOP;
                let scale = 1.0 / FFT_SIZE as f32;
                for i in 0..FFT_SIZE {
                    stem.add_vocal(c, base + i, self.scratch[i].re * scale * self.synthesis[i]);
                }
            }
        }
        Ok(())
    }

    /// The model's vocal share of a bin → removal mask: over-subtract, lift the uncertain
    /// middle, then let it linger after the voice unless a new note starts.
    fn shape(&mut self, estimate: f32, level: f32, c: usize, b: usize) -> f32 {
        let lifted = (estimate * OVER_SUBTRACT).min(1.0).powf(LIFT);
        let onset = level > self.last_level[c][b] * ONSET_RATIO + 1e-6;
        self.last_level[c][b] = level;
        let carried = if onset { 0.0 } else { self.hold[c][b] * self.tail_decay };
        self.hold[c][b] = lifted.max(carried);
        lifted.max(carried * TAIL_AMOUNT)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stft_round_trip_with_full_mask_rebuilds_the_signal() {
        // With mask 1 everywhere the overlap-add must give the input back (away from the edges).
        let mut engine = Engine::new();
        let len = FFT_SIZE * 4;
        let signal: Vec<f32> = (0..len).map(|i| (i as f32 * 0.01).sin() * 0.3).collect();
        let mut out = vec![0.0f32; len + FFT_SIZE];
        for f in 0..(len / HOP) {
            for i in 0..FFT_SIZE {
                engine.scratch[i] = Complex::new(signal.get(f * HOP + i).copied().unwrap_or(0.0) * engine.window[i], 0.0);
            }
            engine.forward.process(&mut engine.scratch);
            engine.inverse.process(&mut engine.scratch);
            for i in 0..FFT_SIZE {
                out[f * HOP + i] += engine.scratch[i].re / FFT_SIZE as f32 * engine.synthesis[i];
            }
        }
        for i in FFT_SIZE..len - FFT_SIZE {
            assert!((out[i] - signal[i]).abs() < 1e-3, "sample {i}: {} vs {}", out[i], signal[i]);
        }
    }

    #[test]
    fn stem_sample_waits_for_processed_and_subtracts() {
        let stem = Stem::new([vec![16384; 10], vec![16384; 10]]);
        assert_eq!(stem.sample(0, 2.0, 1.0), None);
        for i in 0..10 {
            stem.add_vocal(0, i, 0.25);
        }
        stem.processed.store(10, Ordering::Release);
        let value = stem.sample(0, 2.5, 1.0).unwrap();
        assert!((value - 0.25).abs() < 1e-4);
        assert!((stem.sample(0, 2.5, 0.0).unwrap() - 0.5).abs() < 1e-4);
    }

    #[test]
    fn resample_keeps_length_ratio() {
        let input = vec![0.0f32; 48_000];
        assert_eq!(resample(&input, 48_000, 44_100).len(), 44_100);
        assert_eq!(resample(&input, 44_100, 44_100).len(), 48_000);
    }

    /// Runs the real model on a few seconds of noise. Needs VOLNA_VOX_DIR with the dll and model.
    #[test]
    #[ignore]
    fn real_model_runs_one_chunk() {
        let dir = PathBuf::from(std::env::var("VOLNA_VOX_DIR").expect("VOLNA_VOX_DIR"));
        let environment = ort::init_from(dir.join("onnxruntime.dll")).unwrap().build().unwrap();
        let mut builder = ort::session::Session::builder(&environment).unwrap().with_intra_threads(4).unwrap();
        let session = builder.commit_from_file(dir.join("Kim_Vocal_2.onnx")).unwrap();
        for i in session.inputs() {
            println!("input {} {:?}", i.name(), i.dtype());
        }
        let input = session.inputs()[0].name().to_owned();
        let model = Model { session: Mutex::new(session), input };
        let samples: Vec<i16> = (0..RATE as usize * 8).map(|i| ((i * 7919 % 2000) as i16 - 1000) * 4).collect();
        let stem = Stem::new([samples.clone(), samples]);
        let mut engine = Engine::new();
        let started = std::time::Instant::now();
        engine.process(&model, &stem, 0, FRAMES, 0..FRAMES - EDGE).unwrap();
        println!("one chunk ({:.1} s of audio) in {:?}", (FRAMES * HOP) as f64 / f64::from(RATE), started.elapsed());
        assert!((0..stem.len()).any(|i| stem.vocal_at(0, i) != 0.0));
    }
}
