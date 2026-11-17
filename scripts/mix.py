# -*- coding: utf-8 -*-
"""把换声后的人声与原伴奏混成成品（dsh-cover 插件内置版）。

用法: python mix.py <converted_vocal.wav> <instrumental.wav> <out.wav> [人声增益dB] [目标LUFS]

踩过的坑（别改回去）：
  - 这台机器自带的 ffmpeg 太老，amix 不支持 normalize 选项；
    改用 amerge + pan 逐声道相加，不做平均，人声不会被压掉一半。
  - loudnorm 内部会把采样率提到 192kHz，必须显式 -ar 44100，
    否则 340 秒的 wav 会从 58MB 膨胀到 249MB。
"""
import os
import subprocess
import sys

FFMPEG = os.environ.get("DSH_COVER_FFMPEG") or r"D:\GPT-SoVITS-v3lora-20250228-nvidia50\ffmpeg.exe"
FFPROBE = os.environ.get("DSH_COVER_FFPROBE") or r"D:\GPT-SoVITS-v3lora-20250228-nvidia50\ffprobe.exe"


def dur(path):
    out = subprocess.run(
        [FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
        capture_output=True,
        text=True,
    )
    try:
        return float(out.stdout.strip())
    except ValueError:
        return 0.0


def main():
    vocal, inst, out = sys.argv[1], sys.argv[2], sys.argv[3]
    gain = sys.argv[4] if len(sys.argv) > 4 else "0"
    lufs = sys.argv[5] if len(sys.argv) > 5 else "-14"

    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)

    dv, di = dur(vocal), dur(inst)
    print(f"[mix] vocal={dv:.2f}s  inst={di:.2f}s  gain={gain}dB  target={lufs}LUFS")
    if abs(dv - di) > 0.35:
        print(f"[mix] 警告: 人声与伴奏长度差 {abs(dv - di):.2f}s，将按最短对齐")

    tmp = os.path.splitext(out)[0] + "_raw.wav"
    filt = (
        f"[0:a]volume={gain}dB,aresample=44100,aformat=channel_layouts=stereo[v];"
        f"[1:a]aresample=44100,aformat=channel_layouts=stereo[i];"
        f"[v][i]amerge=inputs=2,pan=stereo|c0=c0+c2|c1=c1+c3[o]"
    )
    cmd = [
        FFMPEG, "-y", "-v", "error", "-i", vocal, "-i", inst,
        "-filter_complex", filt, "-map", "[o]", "-ar", "44100", "-ac", "2",
        "-c:a", "pcm_s16le", tmp,
    ]
    subprocess.run(cmd, check=True)

    cmd2 = [
        FFMPEG, "-y", "-v", "error", "-i", tmp,
        "-af", f"loudnorm=I={lufs}:TP=-1.0:LRA=11",
        "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", out,
    ]
    subprocess.run(cmd2, check=True)
    os.remove(tmp)

    print(f"[mix] 输出 {out}  {dur(out):.2f}s  {os.path.getsize(out)/1048576:.1f} MB")


if __name__ == "__main__":
    main()
