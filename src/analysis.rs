//! Turns what the sound card plays into bands, hits and kicks for the visualizer. Runs on its own
//! thread at ~60 Hz and emits `levels` events; the UI never touches audio.

use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::player::Player;

const FFT_SIZE: usize = 2048;
const FRAME: Duration = Duration::from_millis(16);
pub const BANDS: usize = 6;
/// Band edges in Hz: sub, bass, low-mid, mid, upper, air.
const EDGES: [f32; BANDS + 1] = [40.0, 100.0, 250.0, 700.0, 2000.0, 6000.0, 14000.0];
/// A kick is a bass onset above this, and two kicks are at least this far apart.
const KICK_THRESHOLD: f32 = 0.25;
const KICK_GAP: Duration = Duration::from_millis(220);

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Levels {
    pub bands: [f32; BANDS],
    pub bass: f32,
    pub mid: f32,
    pub high: f32,
    pub bass_hit: f32,
    pub mid_hit: f32,
    pub high_hit: f32,
    /// Counts kicks; a change means a kick just landed.
    pub beat: u64,
    pub kick_strength: f32,
    pub playing: bool,
}

pub struct Analyzer {
    fft: Arc<dyn Fft<f32>>,
    window: Vec<f32>,
    smooth: [f32; BANDS],
    average: [f32; BANDS],
    beat: u64,
    kick_strength: f32,
    last_kick: Option<Instant>,
}

impl Analyzer {
    pub fn new() -> Self {
        let fft = FftPlanner::new().plan_fft_forward(FFT_SIZE);
        // Hann window: keeps leakage from one band from showing up in the next.
        let window = (0..FFT_SIZE)
            .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / FFT_SIZE as f32).cos())
            .collect();
        Self {
            fft,
            window,
            smooth: [0.0; BANDS],
            average: [0.0; BANDS],
            beat: 0,
            kick_strength: 0.0,
            last_kick: None,
        }
    }

    /// One analysis step over the latest samples. When paused, levels fall back to zero.
    pub fn process(&mut self, samples: &[f32], sample_rate: u32, playing: bool) -> Levels {
        let raw = if playing && sample_rate > 0 {
            self.band_levels(samples, sample_rate)
        } else {
            [0.0; BANDS]
        };
        self.update(raw, playing);
        self.snapshot(playing)
    }

    /// Mean power per band, mapped from dB to 0…1.
    fn band_levels(&self, samples: &[f32], sample_rate: u32) -> [f32; BANDS] {
        let mut buffer: Vec<Complex<f32>> = samples
            .iter()
            .zip(&self.window)
            .map(|(s, w)| Complex { re: s * w, im: 0.0 })
            .collect();
        self.fft.process(&mut buffer);

        // A full-scale sine gives |X| ≈ N/4 under this window; scaling by that makes bins read as amplitude².
        let scale = (FFT_SIZE as f32 / 4.0).powi(2);
        let bin_hz = sample_rate as f32 / FFT_SIZE as f32;
        let mut out = [0.0; BANDS];
        for (band, level) in out.iter_mut().enumerate() {
            let lo = ((EDGES[band] / bin_hz).floor() as usize).max(1);
            let hi = ((EDGES[band + 1] / bin_hz).ceil() as usize).min(FFT_SIZE / 2);
            if hi <= lo {
                continue;
            }
            let power: f32 = buffer[lo..hi].iter().map(|c| c.norm_sqr()).sum::<f32>() / ((hi - lo) as f32 * scale);
            let db = 10.0 * (power + 1e-12).log10();
            *level = ((db + 60.0) / 45.0).clamp(0.0, 1.0);
        }
        out
    }

    fn update(&mut self, raw: [f32; BANDS], playing: bool) {
        for i in 0..BANDS {
            // Fast attack, slow release: hits pop, tails fade.
            let factor = if raw[i] > self.smooth[i] { 0.6 } else { 0.15 };
            self.smooth[i] += (raw[i] - self.smooth[i]) * factor;
            self.average[i] = self.average[i] * 0.92 + raw[i] * 0.08;
        }
        let now = Instant::now();
        let bass_hit = self.hit(0).max(self.hit(1));
        let ready = self.last_kick.is_none_or(|last| now.duration_since(last) >= KICK_GAP);
        if playing && bass_hit > KICK_THRESHOLD && ready {
            self.beat += 1;
            self.kick_strength = bass_hit.min(1.0);
            self.last_kick = Some(now);
        } else {
            self.kick_strength *= 0.9;
        }
    }

    fn hit(&self, band: usize) -> f32 {
        ((self.smooth[band] - self.average[band]) * 4.0).clamp(0.0, 1.0)
    }

    fn snapshot(&self, playing: bool) -> Levels {
        let s = self.smooth;
        Levels {
            bands: s,
            bass: (s[0] + s[1]) / 2.0,
            mid: (s[2] + s[3]) / 2.0,
            high: (s[4] + s[5]) / 2.0,
            bass_hit: self.hit(0).max(self.hit(1)),
            mid_hit: self.hit(2).max(self.hit(3)),
            high_hit: self.hit(4).max(self.hit(5)),
            beat: self.beat,
            kick_strength: self.kick_strength,
            playing,
        }
    }
}

/// Starts the analysis thread. It emits `levels` every frame while the player exists.
pub fn start(app: AppHandle) {
    let spawned = thread::Builder::new().name("volna-analysis".into()).spawn(move || {
        let mut analyzer = Analyzer::new();
        loop {
            thread::sleep(FRAME);
            let player = app.state::<Player>();
            let samples = player.tap_window(FFT_SIZE);
            let levels = analyzer.process(&samples, player.sample_rate(), player.is_playing());
            let _ = app.emit("levels", levels);
        }
    });
    if let Err(e) = spawned {
        eprintln!("[analysis] thread: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f32, rate: u32, amplitude: f32) -> Vec<f32> {
        (0..FFT_SIZE)
            .map(|i| amplitude * (2.0 * std::f32::consts::PI * freq * i as f32 / rate as f32).sin())
            .collect()
    }

    #[test]
    fn bass_tone_lights_the_bass_bands() {
        let mut analyzer = Analyzer::new();
        let levels = analyzer.process(&sine(60.0, 48_000, 0.5), 48_000, true);
        assert!(levels.bass > levels.high, "bass {} should beat high {}", levels.bass, levels.high);
    }

    #[test]
    fn silence_is_quiet_and_paused() {
        let mut analyzer = Analyzer::new();
        let levels = analyzer.process(&vec![0.0; FFT_SIZE], 48_000, false);
        assert!(!levels.playing);
        assert_eq!(levels.bass, 0.0);
    }
}
