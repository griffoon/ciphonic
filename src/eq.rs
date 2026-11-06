//! Ten-band graphic equalizer: one RBJ peaking biquad per band and channel, run on the audio
//! thread so a slider move is heard at once (the decode buffer is half a second ahead).

/// Band centres in Hz, the classic octave set.
pub const FREQUENCIES: [f32; 10] = [31.0, 62.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0];
pub const BANDS: usize = FREQUENCIES.len();
/// Slider range in dB.
pub const MAX_GAIN_DB: f32 = 12.0;
/// One octave wide.
const Q: f32 = 1.41;
const MAX_CHANNELS: usize = 8;

#[derive(Clone, Copy, Default)]
struct Coeffs {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
}

impl Coeffs {
    /// RBJ cookbook peaking EQ, normalised by a0.
    fn peaking(freq: f32, gain_db: f32, rate: f32) -> Self {
        let a = 10f32.powf(gain_db / 40.0);
        let w0 = 2.0 * std::f32::consts::PI * (freq / rate).min(0.49);
        let alpha = w0.sin() / (2.0 * Q);
        let cos = w0.cos();
        let a0 = 1.0 + alpha / a;
        Self {
            b0: (1.0 + alpha * a) / a0,
            b1: (-2.0 * cos) / a0,
            b2: (1.0 - alpha * a) / a0,
            a1: (-2.0 * cos) / a0,
            a2: (1.0 - alpha / a) / a0,
        }
    }
}

/// Transposed direct form II state.
#[derive(Clone, Copy, Default)]
struct State {
    z1: f32,
    z2: f32,
}

pub struct Equalizer {
    gains: [f32; BANDS],
    rate: f32,
    coeffs: [Coeffs; BANDS],
    state: [[State; BANDS]; MAX_CHANNELS],
    /// Lowers the whole signal by the biggest boost so loud bands don't clip.
    preamp: f32,
    active: bool,
}

impl Default for Equalizer {
    fn default() -> Self {
        Self {
            gains: [0.0; BANDS],
            rate: 48_000.0,
            coeffs: [Coeffs::default(); BANDS],
            state: [[State::default(); BANDS]; MAX_CHANNELS],
            preamp: 1.0,
            active: false,
        }
    }
}

impl Equalizer {
    /// New gains in dB, clamped to the slider range. Flat gains switch the filter off entirely.
    pub fn set_gains(&mut self, gains: &[f32]) {
        for (dst, src) in self.gains.iter_mut().zip(gains) {
            *dst = if src.is_finite() { src.clamp(-MAX_GAIN_DB, MAX_GAIN_DB) } else { 0.0 };
        }
        self.rebuild();
    }

    pub fn set_rate(&mut self, rate: u32) {
        if rate > 0 && (rate as f32 - self.rate).abs() > 0.5 {
            self.rate = rate as f32;
            self.rebuild();
        }
    }

    fn rebuild(&mut self) {
        self.active = self.gains.iter().any(|g| g.abs() > 0.05);
        for (band, coeffs) in self.coeffs.iter_mut().enumerate() {
            *coeffs = Coeffs::peaking(FREQUENCIES[band], self.gains[band], self.rate);
        }
        let boost = self.gains.iter().cloned().fold(0.0f32, f32::max);
        self.preamp = 10f32.powf(-boost / 20.0);
        if !self.active {
            self.state = [[State::default(); BANDS]; MAX_CHANNELS];
        }
    }

    /// Filters interleaved samples in place.
    pub fn process(&mut self, data: &mut [f32], channels: usize) {
        if !self.active || channels == 0 {
            return;
        }
        for frame in data.chunks_mut(channels) {
            for (ch, sample) in frame.iter_mut().enumerate().take(MAX_CHANNELS) {
                let mut x = *sample * self.preamp;
                for (c, s) in self.coeffs.iter().zip(self.state[ch].iter_mut()) {
                    let y = c.b0 * x + s.z1;
                    s.z1 = c.b1 * x - c.a1 * y + s.z2;
                    s.z2 = c.b2 * x - c.a2 * y;
                    x = y;
                }
                *sample = x;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f32, rate: f32, len: usize) -> Vec<f32> {
        (0..len).map(|i| (2.0 * std::f32::consts::PI * freq * i as f32 / rate).sin() * 0.5).collect()
    }

    fn rms(data: &[f32]) -> f32 {
        (data.iter().map(|x| x * x).sum::<f32>() / data.len() as f32).sqrt()
    }

    #[test]
    fn flat_gains_leave_the_signal_untouched() {
        let mut eq = Equalizer::default();
        eq.set_gains(&[0.0; BANDS]);
        let input = sine(440.0, 48_000.0, 4800);
        let mut output = input.clone();
        eq.process(&mut output, 1);
        assert_eq!(input, output);
    }

    #[test]
    fn cutting_a_band_lowers_a_tone_in_it() {
        let mut eq = Equalizer::default();
        let mut gains = [0.0; BANDS];
        gains[5] = -12.0; // 1 kHz
        eq.set_gains(&gains);
        let input = sine(1000.0, 48_000.0, 48_000);
        let mut output = input.clone();
        eq.process(&mut output, 1);
        let ratio = rms(&output[24_000..]) / rms(&input[24_000..]);
        assert!(ratio < 0.4, "1 kHz should drop by about 12 dB, ratio {ratio}");
    }

    #[test]
    fn boosting_does_not_clip_thanks_to_the_preamp() {
        let mut eq = Equalizer::default();
        let mut gains = [0.0; BANDS];
        gains[1] = 12.0;
        eq.set_gains(&gains);
        let mut output = sine(62.0, 48_000.0, 48_000);
        eq.process(&mut output, 1);
        assert!(output[24_000..].iter().all(|x| x.abs() <= 0.75));
    }

    #[test]
    fn gains_are_clamped_and_nan_is_ignored() {
        let mut eq = Equalizer::default();
        eq.set_gains(&[40.0, f32::NAN]);
        assert_eq!(eq.gains[0], MAX_GAIN_DB);
        assert_eq!(eq.gains[1], 0.0);
    }
}
