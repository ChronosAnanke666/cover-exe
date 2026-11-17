# -*- coding: utf-8 -*-
"""Seed-VC 歌声转换运行器（dsh-cover 插件内置版）。

GPT-SoVITS 的 runtime/python.exe 是嵌入式发行版（python39._pth 隔离），
PYTHONPATH 与脚本目录都不会进 sys.path，所以这里显式注入：
  - <PYLIBS>        munch / descript-audiotools 等补充包
  - <REPO>          Seed-VC 源码
并把 cwd 切到 <WORKROOT>，让 hf_utils 的 ./checkpoints 落在 D 盘。

三个路径都能用环境变量覆盖（插件侧会传）：
  DSH_COVER_REPO / DSH_COVER_PYLIBS / DSH_COVER_WORKROOT

用法（参数与官方 inference.py 完全一致）:
  python run_svc.py --source <song_vocal.wav> --target <ref.wav> --output <dir> \
      --f0-condition True --diffusion-steps 30 --fp16 True
"""
import os
import sys

REPO = os.environ.get("DSH_COVER_REPO") or r"D:\AI-Song\src\seed-vc-hf"
PYLIBS = os.environ.get("DSH_COVER_PYLIBS") or r"D:\AI-Song\env\pylibs"
WORKROOT = os.environ.get("DSH_COVER_WORKROOT") or r"D:\AI-Song\models"

for p in (PYLIBS, REPO):
    if p and p not in sys.path:
        sys.path.insert(0, p)

# HuggingFace 走国内镜像；缓存全部落在 WORKROOT 下
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HOME", os.path.join(WORKROOT, "hf_home"))
os.environ.setdefault("HF_HUB_CACHE", os.path.join(WORKROOT, "checkpoints", "hf_cache"))

os.makedirs(WORKROOT, exist_ok=True)
os.chdir(WORKROOT)

TARGET = os.path.join(REPO, "inference.py")
code = open(TARGET, encoding="utf-8").read()
g = {"__name__": "__main__", "__file__": TARGET}
exec(compile(code, TARGET, "exec"), g)
