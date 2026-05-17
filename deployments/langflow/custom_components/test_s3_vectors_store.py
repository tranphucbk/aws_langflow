"""
Test script for S3VectorsStore component.

Chạy: python test_s3_vectors_store.py

Yêu cầu:
  - AWS credentials đã cấu hình (aws configure hoặc IAM role)
  - S3 Vectors bucket đã tạo
  - Bucket phải nằm ở region us-east-1 (hoặc set AWS_DEFAULT_REGION)

Nếu chưa có bucket thực, chỉ test phần 1 (import + class structure).
"""

import sys
import os

# ── Part 1: Import check ────────────────────────────────────────────────────
print("=" * 60)
print("PART 1: Import & class structure check")
print("=" * 60)

try:
    import boto3
    print(f"  ✅ boto3 {boto3.__version__} imported")
except ImportError:
    print("  ❌ boto3 not installed — run: pip install boto3")
    sys.exit(1)

# Langflow không có sẵn trong môi trường local test, dùng mock
try:
    from langflow.custom import Component
    from langflow.io import StrInput, IntInput, MultilineInput, HandleInput, DataInput, Output
    from langflow.schema import Data
    LANGFLOW_AVAILABLE = True
    print("  ✅ langflow imported")
except ImportError:
    LANGFLOW_AVAILABLE = False
    print("  ⚠️  langflow not installed locally (expected) — using mock classes for structure test")

    class Component:
        pass

    class Data:
        def __init__(self, data):
            self.data = data

    StrInput = IntInput = MultilineInput = HandleInput = DataInput = Output = lambda **kw: kw


# Patch imports tạm thời để test class structure
import importlib, types, unittest.mock as mock

# Mock langflow modules nếu chưa cài
if not LANGFLOW_AVAILABLE:
    for mod_name in [
        "langflow", "langflow.custom", "langflow.io",
        "langflow.schema", "langflow.base",
    ]:
        if mod_name not in sys.modules:
            sys.modules[mod_name] = mock.MagicMock()

    sys.modules["langflow.custom"].Component = Component
    sys.modules["langflow.schema"].Data = Data

# Import component
spec = importlib.util.spec_from_file_location(
    "s3_vectors_store",
    os.path.join(os.path.dirname(__file__), "s3_vectors_store.py"),
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
S3VectorsStore = module.S3VectorsStore

print(f"  ✅ S3VectorsStore class loaded")
print(f"     display_name  = {S3VectorsStore.display_name}")
print(f"     icon          = {S3VectorsStore.icon}")

# Check methods exist
for method in ["similarity_search", "ingest_documents", "_build_client", "_validate_config"]:
    assert hasattr(S3VectorsStore, method), f"Missing method: {method}"
print(f"  ✅ All required methods present")


# ── Part 2: boto3 s3vectors client check ───────────────────────────────────
print()
print("=" * 60)
print("PART 2: boto3 s3vectors client check")
print("=" * 60)

BUCKET_NAME = os.environ.get("S3_VECTORS_BUCKET_NAME", "")
INDEX_NAME  = os.environ.get("S3_VECTORS_INDEX_NAME", "langflow-index")
REGION      = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")

if not BUCKET_NAME:
    print("  ⚠️  S3_VECTORS_BUCKET_NAME not set — skipping live AWS tests")
    print("     Set env var to run full test:")
    print("     export S3_VECTORS_BUCKET_NAME=my-langflow-vectors")
    print()
    print("=" * 60)
    print("RESULT: Import check ✅  |  Live AWS test: SKIPPED (no bucket)")
    print("=" * 60)
    sys.exit(0)

try:
    client = boto3.client("s3vectors", region_name=REGION)
    print(f"  ✅ s3vectors client created (region={REGION})")
except Exception as e:
    print(f"  ❌ Failed to create s3vectors client: {e}")
    print("     Ensure boto3 >= 1.38 supports s3vectors")
    sys.exit(1)


# ── Part 3: put_vectors test ───────────────────────────────────────────────
print()
print("=" * 60)
print("PART 3: put_vectors (store 2 test vectors)")
print("=" * 60)

test_vectors = [
    {
        "key": "test-vec-0",
        "data": {"float32": [0.1] * 1536},
        "metadata": {"text": "Hello world — test document 1"},
    },
    {
        "key": "test-vec-1",
        "data": {"float32": [0.2] * 1536},
        "metadata": {"text": "AWS S3 Vectors — test document 2"},
    },
]

try:
    client.put_vectors(
        vectorBucketName=BUCKET_NAME,
        indexName=INDEX_NAME,
        vectors=test_vectors,
    )
    print(f"  ✅ put_vectors: stored {len(test_vectors)} vectors")
except Exception as e:
    print(f"  ❌ put_vectors failed: {e}")
    sys.exit(1)


# ── Part 4: query_vectors test ─────────────────────────────────────────────
print()
print("=" * 60)
print("PART 4: query_vectors (similarity search)")
print("=" * 60)

try:
    response = client.query_vectors(
        vectorBucketName=BUCKET_NAME,
        indexName=INDEX_NAME,
        queryVector={"float32": [0.1] * 1536},
        topK=2,
        returnDistance=True,
        returnMetadata={"all": {}},
    )
    vectors = response.get("vectors", [])
    print(f"  ✅ query_vectors: returned {len(vectors)} results")
    for v in vectors:
        print(f"     key={v['key']}, distance={v.get('distance'):.4f}, text={v.get('metadata',{}).get('text','')[:50]}")
except Exception as e:
    print(f"  ❌ query_vectors failed: {e}")
    sys.exit(1)


print()
print("=" * 60)
print("RESULT: All tests PASSED ✅")
print("=" * 60)
