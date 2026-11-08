#!/usr/bin/env python3
"""
Export a Hugging Face image-classification model to a quantized ONNX file plus
a CleanFeed model manifest, ready to import in Options → Image model.

    pip install "transformers>=4.40" torch onnx onnxruntime pillow
    python3 scripts/export-model.py <model-id-or-local-path> out/

Outputs:
    out/model.onnx            fp32 export
    out/model_quantized.onnx  int8 dynamic-quantized (smaller, faster in WASM)
    out/cleanfeed-model.json  manifest (input size, normalization, AI class)

Works for standard `AutoModelForImageClassification` checkpoints (ViT,
ConvNeXt, Swin, SigLIP, EfficientNet…). For research detectors that ship as
plain PyTorch/timm code (e.g. Community Forensics), build the model with
their code, load the weights, and call `export(model, ...)` below with the
matching preprocessing values.

The AI/"fake" class index is guessed from the label names; check the printed
labels and edit the manifest if needed.
"""
import json
import os
import re
import sys


def export(model, out_dir, size, mean, std, labels, name):
    import torch

    os.makedirs(out_dir, exist_ok=True)
    model.eval()
    dummy = torch.randn(1, 3, size, size)
    fp32 = os.path.join(out_dir, "model.onnx")

    class Wrapper(torch.nn.Module):
        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, pixel_values):
            out = self.m(pixel_values)
            return out.logits if hasattr(out, "logits") else out

    torch.onnx.export(
        Wrapper(model), dummy, fp32, input_names=["pixel_values"], output_names=["logits"],
        opset_version=17, dynamic_axes=None,
    )
    q = os.path.join(out_dir, "model_quantized.onnx")
    try:
        from onnxruntime.quantization import QuantType, quantize_dynamic

        quantize_dynamic(fp32, q, weight_type=QuantType.QUInt8)
    except Exception as e:  # quantization is optional
        print("quantization skipped:", e)
        q = fp32

    ai_index = 1
    for i, lab in enumerate(labels):
        if re.search(r"\b(ai|fake|artificial|generated|synthetic|diffusion)\b", lab.lower().replace("_", " ")):
            ai_index = i
            break
    manifest = {
        "id": name.replace("/", "-"),
        "name": name,
        "inputSize": size,
        "layout": "NCHW",
        "mean": list(mean),
        "std": list(std),
        "output": "softmax" if len(labels) > 1 else "sigmoid",
        "aiIndex": ai_index if len(labels) > 1 else 0,
        "labels": labels,
        "inputName": "pixel_values",
        "outputName": "logits",
        "resize": "center-crop",
        "source": name,
    }
    with open(os.path.join(out_dir, "cleanfeed-model.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    print("labels:", labels, "→ aiIndex", manifest["aiIndex"])
    print("wrote", q, f"({os.path.getsize(q) / 1e6:.1f} MB) and cleanfeed-model.json")


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    model_id, out_dir = sys.argv[1], sys.argv[2]
    from transformers import AutoImageProcessor, AutoModelForImageClassification

    proc = AutoImageProcessor.from_pretrained(model_id)
    model = AutoModelForImageClassification.from_pretrained(model_id)
    size = proc.size.get("shortest_edge") or proc.size.get("height") if isinstance(proc.size, dict) else proc.size
    labels = [model.config.id2label[i] for i in range(len(model.config.id2label))]
    export(model, out_dir, int(size or 224), proc.image_mean, proc.image_std, labels, model_id)


if __name__ == "__main__":
    main()
