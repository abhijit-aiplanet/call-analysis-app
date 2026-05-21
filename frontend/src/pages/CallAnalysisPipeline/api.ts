// API client for the Call Analysis Pipeline backend (port 8007).
import axios from "axios";
import type {
  AnalyzeResponse,
  BatchCreateResponse,
  BatchJob,
} from "./types";

export const API_BASE_URL =
  import.meta.env.VITE_CALL_ANALYSIS_API_URL || "http://localhost:8007";

export interface PricingResponse {
  rate_card: Record<string, number>;
  notes: string[];
}

// ─── Legacy single-file endpoint (still works, used for one-off testing) ────
export const analyzeCall = async (
  file: File,
  keyterms?: string[]
): Promise<AnalyzeResponse> => {
  const formData = new FormData();
  formData.append("file", file);
  if (keyterms && keyterms.length > 0) {
    formData.append("keyterms", keyterms.join(","));
  }
  const response = await axios.post<AnalyzeResponse>(
    `${API_BASE_URL}/analyze`,
    formData,
    {
      headers: { "Content-Type": "multipart/form-data" },
      timeout: 300000,
    }
  );
  return response.data;
};

// ─── Batch endpoints ────────────────────────────────────────────────────────
export const createBatch = async (
  files: File[],
  keyterms?: string[]
): Promise<BatchCreateResponse> => {
  const formData = new FormData();
  for (const f of files) formData.append("files", f);
  if (keyterms && keyterms.length > 0) {
    formData.append("keyterms", keyterms.join(","));
  }
  const response = await axios.post<BatchCreateResponse>(
    `${API_BASE_URL}/batch`,
    formData,
    {
      headers: { "Content-Type": "multipart/form-data" },
      // Upload can take a while for large batches; processing is async after submit
      timeout: 600000,
    }
  );
  return response.data;
};

export const getBatch = async (jobId: string): Promise<BatchJob> => {
  const response = await axios.get<BatchJob>(`${API_BASE_URL}/batch/${jobId}`);
  return response.data;
};

export const deleteBatch = async (jobId: string): Promise<void> => {
  await axios.delete(`${API_BASE_URL}/batch/${jobId}`);
};

export const getPricing = async (): Promise<PricingResponse> => {
  const response = await axios.get<PricingResponse>(`${API_BASE_URL}/pricing`);
  return response.data;
};

export const getHealth = async () => {
  const response = await axios.get(`${API_BASE_URL}/health`);
  return response.data;
};

export { API_BASE_URL };
