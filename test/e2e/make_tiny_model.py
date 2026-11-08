"""Builds a tiny ONNX classifier used by the end-to-end test of the inference
pipeline (not a real AI-image detector!).

Graph: input [1,3,224,224] -> mean over H,W -> Gemm(3->2) -> logits [1,2].
Redder images score higher on class 1 ("AI" in the test manifest), bluer ones on class 0.

    pip install onnx && python3 test/e2e/make_tiny_model.py
"""
import os
import onnx
from onnx import TensorProto, helper

W = helper.make_tensor("W", TensorProto.FLOAT, [3, 2], [-4.0, 4.0, 0.0, 0.0, 4.0, -4.0][::-1])
B = helper.make_tensor("B", TensorProto.FLOAT, [2], [0.0, 0.0])
nodes = [
    helper.make_node("ReduceMean", ["pixel_values"], ["pooled"], axes=[2, 3], keepdims=0),
    helper.make_node("Gemm", ["pooled", "W", "B"], ["logits"]),
]
graph = helper.make_graph(
    nodes,
    "cleanfeed-tiny-test",
    [helper.make_tensor_value_info("pixel_values", TensorProto.FLOAT, [1, 3, 224, 224])],
    [helper.make_tensor_value_info("logits", TensorProto.FLOAT, [1, 2])],
    initializer=[W, B],
)
model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)], producer_name="cleanfeed-test")
model.ir_version = 8
onnx.checker.check_model(model)
out = os.path.join(os.path.dirname(__file__), "fixtures", "tiny-classifier.onnx")
onnx.save(model, out)
print("wrote", out, os.path.getsize(out), "bytes")
