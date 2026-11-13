//! Reverb for «slowed + reverb»: the classic Freeverb (public-domain design by Jezar at
//! Dreampoint) — eight lowpass-feedback comb filters in parallel and four allpasses in series per
//! channel, the right channel a little longer so the hall sounds wide. Runs on the audio thread.

/// Comb and allpass lengths in samples at 44.1 kHz.
const COMBS: [usize; 8] = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASSES: [usize; 4] = [556, 441, 341, 225];
const STEREO_SPREAD: usize = 23;
/// A big hall: long feedback, gentle damping.
const ROOM: f32 = 0.88;
const DAMP: f32 = 0.3;
const INPUT_GAIN: f32 = 0.015;
const ALLPASS_FEEDBACK: f32 = 0.5;
/// Wet level at full amount, and how much the dry signal dips under it.
const WET: f32 = 2.4;
const DRY_DIP: f32 = 0.4;

struct Comb {
    buffer: Vec<f32>,
    index: usize,
    store: f32,
}

impl Comb {
    fn new(len: usize) -> Self {
        Self { buffer: vec![0.0; len.max(1)], index: 0, store: 0.0 }
    }

    fn process(&mut self, input: f32) -> f32 {
        let output = self.buffer[self.index];
        self.store = output * (1.0 - DAMP) + self.store * DAMP;
        self.buffer[self.index] = input + self.store * ROOM;
        self.index = (self.index + 1) % self.buffer.len();
        output
    }
}

struct Allpass {
    buffer: Vec<f32>,
    index: usize,
}

impl Allpass {
    fn new(len: usize) -> Self {
        Self { buffer: vec![0.0; len.max(1)], index: 0 }
    }

    fn process(&mut self, input: f32) -> f32 {
        let delayed = self.buffer[self.index];
        self.buffer[self.index] = input + delayed * ALLPASS_FEEDBACK;
        self.index = (self.index + 1) % self.buffer.len();
        delayed - input
    }
}

struct Channel {
    combs: Vec<Comb>,
    allpasses: Vec<Allpass>,
}

impl Channel {
    fn new(rate: u32, spread: usize) -> Self {
        let scale = |len: usize| ((len + spread) as f64 * f64::from(rate) / 44_100.0) as usize;
        Self {
            combs: COMBS.iter().map(|&len| Comb::new(scale(len))).collect(),
            allpasses: ALLPASSES.iter().map(|&len| Allpass::new(scale(len))).collect(),
        }
    }

    fn process(&mut self, input: f32) -> f32 {
        let mut out: f32 = self.combs.iter_mut().map(|c| c.process(input)).sum();
        for allpass in &mut self.allpasses {
            out = allpass.process(out);
        }
        out
    }
}

#[derive(Default)]
pub struct Reverb {
    rate: u32,
    channels: Vec<Channel>,
}

impl Reverb {
    /// Mixes the hall into interleaved samples. `amount` 0…1; 0 leaves the sound untouched.
    pub fn process(&mut self, data: &mut [f32], channels: usize, rate: u32, amount: f32) {
        if amount <= 0.001 || channels == 0 {
            if !self.channels.is_empty() {
                // Off: drop the tail so turning it on again starts clean.
                self.channels.clear();
            }
            return;
        }
        if self.rate != rate || self.channels.len() != channels {
            self.rate = rate;
            self.channels = (0..channels).map(|c| Channel::new(rate, if c % 2 == 1 { STEREO_SPREAD } else { 0 })).collect();
        }
        let wet = amount * WET;
        let dry = 1.0 - DRY_DIP * amount;
        for frame in data.chunks_mut(channels) {
            // Freeverb feeds both sides with the mono sum.
            let input = frame.iter().sum::<f32>() / channels as f32 * INPUT_GAIN;
            for (sample, channel) in frame.iter_mut().zip(self.channels.iter_mut()) {
                *sample = *sample * dry + channel.process(input) * wet;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_amount_passes_through() {
        let mut reverb = Reverb::default();
        let mut data = vec![0.5, -0.5, 0.25, -0.25];
        reverb.process(&mut data, 2, 44_100, 0.0);
        assert_eq!(data, vec![0.5, -0.5, 0.25, -0.25]);
    }

    #[test]
    fn an_impulse_leaves_a_decaying_tail() {
        let mut reverb = Reverb::default();
        let mut data = vec![0.0f32; 44_100 * 2 * 3];
        data[0] = 1.0;
        data[1] = 1.0;
        reverb.process(&mut data, 2, 44_100, 1.0);
        let energy = |range: std::ops::Range<usize>| data[range].iter().map(|x| x * x).sum::<f32>();
        let early = energy(44_100..88_200);
        let late = energy(176_400..264_600);
        assert!(early > 0.0, "the hall should ring after the impulse");
        assert!(late < early, "the tail should decay");
        assert!(data.iter().all(|x| x.is_finite() && x.abs() < 2.0));
    }
}
