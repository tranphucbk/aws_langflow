"""
Amazon S3 Vectors — Custom Langflow Component

Requires:
  - boto3 >= 1.38 (s3vectors support)
  - AWS credentials with s3vectors:PutVectors, s3vectors:QueryVectors, s3vectors:GetVectors

Env vars (auto-set by ECS task definition):
  S3_VECTORS_BUCKET_NAME, S3_VECTORS_INDEX_NAME, AWS_DEFAULT_REGION
"""

import os
import json
import boto3
from botocore.exceptions import ClientError

from langflow.custom import Component
from langflow.io import (
    DataInput,
    HandleInput,
    IntInput,
    Output,
    StrInput,
    MultilineInput,
)
from langflow.schema import Data


class S3VectorsStore(Component):
    display_name = "Amazon S3 Vectors"
    description = "Store and query vector embeddings using Amazon S3 Vectors (AWS managed vector database)"
    icon = "AmazonWebServices"
    name = "S3VectorsStore"

    inputs = [
        StrInput(
            name="bucket_name",
            display_name="S3 Vectors Bucket Name",
            info="Name of the S3 Vectors bucket. Reads from S3_VECTORS_BUCKET_NAME env var if empty.",
            value="",
        ),
        StrInput(
            name="index_name",
            display_name="Vector Index Name",
            info="Name of the vector index within the bucket. Reads from S3_VECTORS_INDEX_NAME env var if empty.",
            value="",
        ),
        StrInput(
            name="region",
            display_name="AWS Region",
            info="AWS region where the S3 Vectors bucket is located.",
            value="us-east-1",
        ),
        IntInput(
            name="top_k",
            display_name="Top K Results",
            info="Number of similar vectors to return from similarity search.",
            value=5,
        ),
        MultilineInput(
            name="search_query",
            display_name="Search Query",
            info="Text query to search. Will be embedded using the connected Embeddings model.",
            value="",
        ),
        HandleInput(
            name="embedding_model",
            display_name="Embedding Model",
            input_types=["Embeddings"],
            info="Langflow Embeddings component to generate vector embeddings.",
        ),
        DataInput(
            name="documents",
            display_name="Documents to Ingest",
            info="Documents to embed and store (optional — used for ingest mode).",
            is_list=True,
            required=False,
        ),
    ]

    outputs = [
        Output(display_name="Search Results", name="search_results", method="similarity_search"),
        Output(display_name="Ingest Status", name="ingest_status", method="ingest_documents"),
    ]

    def _get_bucket_name(self) -> str:
        return self.bucket_name or os.environ.get("S3_VECTORS_BUCKET_NAME", "")

    def _get_index_name(self) -> str:
        return self.index_name or os.environ.get("S3_VECTORS_INDEX_NAME", "langflow-index")

    def _get_region(self) -> str:
        return self.region or os.environ.get("AWS_DEFAULT_REGION", "us-east-1")

    def _build_client(self):
        return boto3.client("s3vectors", region_name=self._get_region())

    def _validate_config(self):
        bucket = self._get_bucket_name()
        if not bucket:
            raise ValueError(
                "S3 Vectors bucket name is required. Set 'bucket_name' input or "
                "S3_VECTORS_BUCKET_NAME environment variable."
            )
        return bucket, self._get_index_name()

    def similarity_search(self) -> list[Data]:
        """Embed the search_query and return top_k similar vectors from S3 Vectors."""
        bucket, index = self._validate_config()

        if not self.search_query:
            self.status = "No search query provided."
            return []

        if not self.embedding_model:
            raise ValueError("Embedding Model is required for similarity search.")

        query_vector = self.embedding_model.embed_query(self.search_query)

        client = self._build_client()
        try:
            response = client.query_vectors(
                vectorBucketName=bucket,
                indexName=index,
                queryVector={"float32": query_vector},
                topK=self.top_k,
                returnDistance=True,
                returnMetadata=True,
            )
        except ClientError as e:
            raise RuntimeError(f"S3 Vectors query_vectors failed: {e.response['Error']['Message']}") from e

        results = []
        for item in response.get("vectors", []):
            results.append(
                Data(
                    data={
                        "key": item["key"],
                        "distance": item.get("distance"),
                        "text": item.get("metadata", {}).get("text", ""),
                        "metadata": item.get("metadata", {}),
                    }
                )
            )

        self.status = f"Found {len(results)} results for query: '{self.search_query[:60]}'"
        return results

    def ingest_documents(self) -> Data:
        """Embed documents and store them in S3 Vectors."""
        bucket, index = self._validate_config()

        if not self.documents:
            self.status = "No documents provided for ingestion."
            return Data(data={"status": "skipped", "message": "No documents provided."})

        if not self.embedding_model:
            raise ValueError("Embedding Model is required for document ingestion.")

        texts = [doc.get_text() if hasattr(doc, "get_text") else str(doc.data) for doc in self.documents]
        vectors_data = self.embedding_model.embed_documents(texts)

        vectors = []
        for i, (text, vector) in enumerate(zip(texts, vectors_data)):
            vectors.append(
                {
                    "key": f"doc-{i}",
                    "data": {"float32": vector},
                    "metadata": {"text": text[:2000]},
                }
            )

        client = self._build_client()
        # S3 Vectors API limit: 500 vectors per put_vectors call
        batch_size = 500
        total_stored = 0
        for batch_start in range(0, len(vectors), batch_size):
            batch = vectors[batch_start : batch_start + batch_size]
            try:
                client.put_vectors(
                    vectorBucketName=bucket,
                    indexName=index,
                    vectors=batch,
                )
                total_stored += len(batch)
            except ClientError as e:
                raise RuntimeError(
                    f"S3 Vectors put_vectors failed at batch {batch_start}: "
                    f"{e.response['Error']['Message']}"
                ) from e

        self.status = f"Stored {total_stored} vectors in s3vectors://{bucket}/{index}"
        return Data(
            data={
                "status": "success",
                "bucket": bucket,
                "index": index,
                "vectors_stored": total_stored,
            }
        )
