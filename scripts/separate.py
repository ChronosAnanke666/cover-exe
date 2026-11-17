# -*- coding: utf-8 -*-
"""人声分离：复用 GPT-SoVITS 自带的 BS-RoFormer (UVR5) 权重，不额外下载。

用法: python separate.py <输入音频或目录> <输出目录>
产物: <输出目录>/vocals/<name>_vocals.wav 与 <输出目录>/instrumental/<name>_other.wav

路径可用环境变量覆盖：
  DSH_COVER_UVR5       UVR5 目录（默认 GPT-SoVITS 自带）
  DSH_COVER_UVR5_MODEL 指定 ckpt（默认 uvr5_weights 里的 bs_roformer）
"""
import os
import sys

UVR5 = os.environ.get("DSH_COVER_UVR5") or r"D:\GPT-SoVITS-v3lora-20250228-nvidia50\tools\uvr5"
sys.path.insert(0, UVR5)

from bsroformer import Roformer_Loader  # noqa: E402

WEIGHTS = os.path.join(UVR5, "uvr5_weights")
MODEL = os.environ.get("DSH_COVER_UVR5_MODEL") or os.path.join(
    WEIGHTS, "model_bs_roformer_ep_317_sdr_12.9755.ckpt"
)
CONFIG = os.path.splitext(MODEL)[0] + ".yaml"  # 不存在时用内置默认配置


def main():
    src = sys.argv[1]
    out = sys.argv[2]
    vocal_root = os.path.join(out, "vocals")
    others_root = os.path.join(out, "instrumental")
    os.makedirs(vocal_root, exist_ok=True)
    os.makedirs(others_root, exist_ok=True)

    print(f"[separate] model={os.path.basename(MODEL)}")
    print(f"[separate] config_exists={os.path.exists(CONFIG)}")
    loader = Roformer_Loader(MODEL, CONFIG, "cuda", True)
    print("[separate] model loaded, running...")
    loader.run_folder(src, vocal_root, others_root, "wav")
    print("[separate] done")
    for d in (vocal_root, others_root):
        for f in os.listdir(d):
            p = os.path.join(d, f)
            print(f"  {p}  {os.path.getsize(p)/1048576:.1f} MB")


if __name__ == "__main__":
    main()
