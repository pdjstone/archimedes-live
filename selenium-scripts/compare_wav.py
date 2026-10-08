#!/usr/bin/env python
"""Compare two 16-bit PCM WAV files sample-exactly.

If the files match exactly this prints 'exact match' and exits 0. Otherwise it
prints diagnostics - the cross-correlation offset between the two files, the
first differing frame, the maximum absolute sample difference and the SNR -
and exits 1.

Used to compare audio dumps between the main and worker-refactor branches
(see selenium-scripts/fetch_audio_dump.py).

Usage:
  scripts/compare_wav.py dump-a.wav dump-b.wav [--max-offset SECONDS]
"""
import argparse
import array
import math
import sys
import wave
from operator import mul


def read_wav(path):
    """Returns ((channels, rate), samples) where samples is an array('h')."""
    with wave.open(str(path), 'rb') as w:
        if w.getsampwidth() != 2:
            raise SystemExit(f'{path}: only 16-bit PCM WAV files are supported')
        if w.getcomptype() != 'NONE':
            raise SystemExit(f'{path}: compressed WAV files are not supported')
        params = (w.getnchannels(), w.getframerate())
        raw = w.readframes(w.getnframes())
    samples = array.array('h')
    samples.frombytes(raw)
    if sys.byteorder == 'big':
        samples.byteswap()  # WAV samples are little-endian
    return params, samples


def correlate_offset(a, b, channels, rate, max_offset):
    """Best lag of b relative to a, in frames, by normalised cross-correlation
    of the decimated left channel. A positive lag means b lags a, i.e.
    b[i] ~ a[i - lag]. Returns (lag_frames, resolution_frames, correlation)."""
    step = max(1, rate // 1000)  # search at ~1kHz to keep this fast in pure Python
    da = a[0::channels * step]
    db = b[0::channels * step]
    if len(da) < 2 or len(db) < 2:
        return 0, step, 0.0
    n = min(len(da), len(db))
    # Zero-mean, so that a DC offset does not dominate the correlation
    da = [x - sum(da) / len(da) for x in da]
    db = [x - sum(db) / len(db) for x in db]
    # Prefix sums of squares, so each lag's overlap energies are O(1)
    pa = [0.0]
    for x in da:
        pa.append(pa[-1] + x * x)
    pb = [0.0]
    for x in db:
        pb.append(pb[-1] + x * x)
    max_lag = min(int(max_offset * rate / step), n - 1)

    def score(lag):
        if lag >= 0:
            m = n - lag  # pairs (da[i], db[i+lag]) for i in [0, m)
            if m < 2:
                return -2.0
            sxy = sum(map(mul, da[0:m], db[lag:lag + m]))
            sxx = pa[m]
            syy = pb[lag + m] - pb[lag]
        else:
            m = n + lag  # pairs (da[i], db[i+lag]) for i in [-lag, n)
            if m < 2:
                return -2.0
            sxy = sum(map(mul, da[-lag:n], db[0:m]))
            sxx = pa[n] - pa[-lag]
            syy = pb[m]
        if sxx <= 0.0 or syy <= 0.0:
            return -2.0
        return sxy / math.sqrt(sxx * syy)

    def best_in(lags):
        best_lag, best_score = 0, -2.0
        for lag in lags:
            sc = score(lag)
            if sc > best_score:
                best_lag, best_score = lag, sc
        return best_lag, best_score

    # Coarse pass at 10x the search step, then refine around the winner
    coarse_lag, _ = best_in(range(-max_lag, max_lag + 1, 10))
    lo = max(-max_lag, coarse_lag - 10)
    hi = min(max_lag, coarse_lag + 10)
    fine_lag, fine_score = best_in(range(lo, hi + 1))
    return fine_lag * step, step, fine_score


def main():
    ap = argparse.ArgumentParser(
        description='Compare two 16-bit PCM WAV files sample-exactly.')
    ap.add_argument('a', help='reference WAV file')
    ap.add_argument('b', help='WAV file to compare against the reference')
    ap.add_argument('--max-offset', type=float, default=0.5,
                    help='maximum cross-correlation offset to search, in seconds '
                         '(default: 0.5)')
    args = ap.parse_args()

    (ch_a, rate_a), a = read_wav(args.a)
    (ch_b, rate_b), b = read_wav(args.b)
    if (ch_a, rate_a) != (ch_b, rate_b):
        print(f'format mismatch: {args.a} is {ch_a}ch {rate_a}Hz, '
              f'{args.b} is {ch_b}ch {rate_b}Hz')
        return 1
    channels, rate = ch_a, rate_a
    frames_a, frames_b = len(a) // channels, len(b) // channels
    n = min(len(a), len(b))

    print(f'{args.a}: {frames_a} frames, {channels}ch {rate}Hz')
    print(f'{args.b}: {frames_b} frames, {channels}ch {rate}Hz')
    if frames_a != frames_b:
        print(f'length mismatch: comparing the first {n // channels} frames')

    if a[:n] == b[:n]:
        print(f'exact match over {n // channels} frames '
              f'({n // channels / rate:.3f}s)')
        return 0 if frames_a == frames_b else 1

    # Not an exact match: first differing frame, max |diff| and SNR at offset 0
    first_diff = None
    max_diff = 0
    sum_ref2 = 0
    sum_diff2 = 0
    for i, (x, y) in enumerate(zip(a, b)):
        d = x - y
        if d:
            if first_diff is None:
                first_diff = i // channels
            ad = d if d > 0 else -d
            if ad > max_diff:
                max_diff = ad
        sum_ref2 += x * x
        sum_diff2 += d * d

    if sum_ref2 > 0:
        snr = f'{10 * math.log10(sum_ref2 / sum_diff2):.1f} dB'
    else:
        snr = 'undefined (reference is silent)'

    lag, resolution, corr = correlate_offset(a, b, channels, rate, args.max_offset)
    if lag > 0:
        direction = 'b lags a'
    elif lag < 0:
        direction = 'b leads a'
    else:
        direction = 'no shift'

    print('not an exact match:')
    print(f'  cross-correlation offset: {lag} frames ({lag / rate:+.3f}s, {direction}, '
          f'correlation {corr:.3f}, resolution +/-{resolution} frames)')
    print(f'  first differing frame: {first_diff} ({first_diff / rate:.3f}s)')
    print(f'  max |diff|: {max_diff}')
    print(f'  SNR: {snr}')
    return 1


if __name__ == '__main__':
    sys.exit(main())
