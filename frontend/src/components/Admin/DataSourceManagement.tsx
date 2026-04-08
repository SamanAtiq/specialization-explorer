import { useState, useEffect } from "react";
import {
  Search,
  Upload,
  Trash2,
  RefreshCw,
  FileText,
  Users,
  HelpCircle,
  Loader2,
  AlertTriangle,
  MessageCircleMore,
} from "lucide-react";
import { AuthService } from "@/functions/authService";
import { getCurrentUser } from "aws-amplify/auth";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import MetricCard from "./MetricCard.tsx";

type AnalyticsTotals = {
  users: number;
  chat_sessions: number;
  messages: number;
  questions?: number;
};

type DataSourceType = "csv" | "json" | "website";

type DataSourceRow = {
  id: string;
  name: string; // file name or URL
  type: DataSourceType;
  created_at: string; // ISO string
  metadata: Record<string, unknown>;
  include_patterns?: string[]; // parsed array
  exclude_patterns?: string[]; // parsed array
};

type IngestionRunRow = {
  id: string;
  data_source_id: string;
  status: "completed" | "failed" | "running";
  error_message?: string | null;
  created_at: string;
  completed_at?: string | null;
};

type AdminDataSourcesResponse = {
  items: Array<{
    data_source: DataSourceRow;
    latest_ingestion_run: IngestionRunRow | null;
  }>;
};

type PresignedUploadResponse = {
  presignedUrl: string;
  bucket: string;
  key: string;
};

function formatDateTime(iso?: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function typeLabel(t: DataSourceType) {
  if (t === "website") return "Website";
  if (t === "csv") return "CSV";
  if (t === "json") return "JSON";
  return t;
}

function statusBadge(status: IngestionRunRow["status"] | "no_runs") {
  switch (status) {
    case "completed":
      return <Badge className="bg-green-100 text-green-700">Completed</Badge>;
    case "failed":
      return <Badge className="bg-red-100 text-red-700">Failed</Badge>;
    case "running":
      return <Badge className="bg-blue-100 text-blue-700">Running</Badge>;
    default:
      return <Badge className="bg-gray-100 text-gray-700">No runs</Badge>;
  }
}

function parsePatterns(text: string): string[] {
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function formatSizeMb(file: File | null) {
  if (!file) return "";
  return `${(file.size / (1024 * 1024)).toFixed(2)} MB`;
}

function validateCsvFile(file: File): string | null {
  const isCsv =
    file.name.toLowerCase().endsWith(".csv") || file.type === "text/csv";

  if (!isCsv) return "Only CSV files are allowed.";
  if (file.size > 50 * 1024 * 1024) return "CSV file size must be less than 50MB.";
  return null;
}

function validateMetadataFile(file: File): string | null {
  const lower = file.name.toLowerCase();
  const isJson =
    lower.endsWith(".json") || file.type === "application/json" || file.type === "text/json";

  if (!isJson) return "Only JSON metadata files are allowed.";
  if (file.size > 50 * 1024 * 1024) return "Metadata JSON file size must be less than 50MB.";
  return null;
}

function expectedMetadataFileName(csvFileName: string) {
  return `${csvFileName}.metadata.json`;
}

export default function DataSourceManagement() {
  const [adminEmail, setAdminEmail] = useState<string | null>(null);
  const [isUrlDialogOpen, setIsUrlDialogOpen] = useState(false);
  const [webUrl, setWebUrl] = useState("");
  const [webUrlStatus, setWebUrlStatus] = useState<{ type: "success" | "error" | null; message: string }>({ type: null, message: "" });
  const [addingUrl, setAddingUrl] = useState(false);

  const [searchQuery, setSearchQuery] = useState("");
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [metadataFile, setMetadataFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<{
    type: "success" | "error" | null;
    message: string;
  }>({ type: null, message: "" });

  const [totals, setTotals] = useState<AnalyticsTotals>({
    users: 0,
    chat_sessions: 0,
    messages: 0,
    questions: 0,
  });

  const [dataSources, setDataSources] = useState<DataSourceRow[]>([]);
  const [ingestionRuns, setIngestionRuns] = useState<IngestionRunRow[]>([]);

  // shows subrow
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [includePatternsText, setIncludePatternsText] = useState("");
  const [excludePatternsText, setExcludePatternsText] = useState("");

  const PAGE_SIZE = 5;
  const [page, setPage] = useState(1);

  const fetchAdminCredentials = async () => {
    const user = await getCurrentUser();
    const email = user?.signInDetails?.loginId ?? null;
    setAdminEmail(email);
  };

  const fetchAnalyticsTotals = async () => {
    try {
      setLoading(true);
      setError(null);

      const session = await AuthService.getAuthSession(true);
      const token = session.tokens.idToken;

      // no timeRange so backend returns ALL-TIME totals
      const res = await fetch(`${import.meta.env.VITE_API_ENDPOINT}/admin/analytics`, {
        headers: {
          Authorization: token,
          "Content-Type": "application/json",
        },
      });

      if (!res.ok) throw new Error("Failed to fetch analytics");

      const data = (await res.json()) as { totals: AnalyticsTotals };

      setTotals({
        users: data.totals?.users ?? 0,
        chat_sessions: data.totals?.chat_sessions ?? 0,
        messages: data.totals?.messages ?? 0,
        questions: data.totals?.questions ?? 0,
      });
    } catch (e) {
      console.error(e);
      setError("Failed to load analytics");
    } finally {
      setLoading(false);
    }
  };

  const fetchAdminDataSources = async () => {
    try {
      setLoading(true);
      setError(null);

      const session = await AuthService.getAuthSession(true);
      const token = session.tokens.idToken;

      const res = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/admin/data_sources`,
        {
        headers: {
          Authorization: token,
          "Content-Type": "application/json",
        },
        }
      );

      if (!res.ok) throw new Error("Failed to fetch data sources");

      const data = (await res.json()) as AdminDataSourcesResponse;

      const ds = data.items.map((x) => x.data_source);
      const runs = data.items
        .map((x) => x.latest_ingestion_run)
        .filter((r): r is IngestionRunRow => !!r);

      setDataSources(ds);
      setIngestionRuns(runs);
    } catch (e) {
      console.error(e);
      setError("Failed to load data sources");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAdminCredentials();
    fetchAnalyticsTotals();
    fetchAdminDataSources();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setPage(1);
  }, [searchQuery]);

  useEffect(() => {
    setPage(1);
  }, [dataSources.length]);

  const handleAddWebUrl = async () => {
    setAddingUrl(true);
    try {
      setWebUrlStatus({ type: null, message: "" });

      if (!webUrl || !/^https?:\/\//.test(webUrl.trim())) {
        setWebUrlStatus({
          type: "error",
          message: "Please enter a valid URL (must start with http:// or https://).",
        });
        return;
      }

      const include_patterns = parsePatterns(includePatternsText);
      const exclude_patterns = parsePatterns(excludePatternsText);

      const session = await AuthService.getAuthSession(true);
      const token = session.tokens.idToken;

      const res = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/admin/data_sources/website`,
        {
          method: "POST",
          headers: {
            Authorization: token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: webUrl.trim(),
            include_patterns,
            exclude_patterns,
            created_by: adminEmail,
            metadata: {},
          }),
        }
      );

      const responseJson = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(responseJson?.error || responseJson?.message || "Failed to add URL");
      }

      setWebUrlStatus({
        type: "success",
        message: responseJson?.message || "URL added successfully.",
      });

      await fetchAdminDataSources();

      setTimeout(() => {
        setIsUrlDialogOpen(false);
        setWebUrl("");
        setIncludePatternsText("");
        setExcludePatternsText("");
        setWebUrlStatus({ type: null, message: "" });
      }, 800);
    } catch (e) {
      console.error(e);
      setWebUrlStatus({
        type: "error",
        message: e instanceof Error ? e.message : "Failed to add URL",
      });
    } finally {
      setAddingUrl(false);
    }
  };

  const handleCsvFileSelect = (selectedFile: File) => {
    setUploadStatus({ type: null, message: "" });
    const validationError = validateCsvFile(selectedFile);
    if (validationError) {
      setUploadStatus({ type: "error", message: validationError });
      return;
    }
    setCsvFile(selectedFile);
  };

  const handleMetadataFileSelect = (selectedFile: File) => {
    setUploadStatus({ type: null, message: "" });
    const validationError = validateMetadataFile(selectedFile);
    if (validationError) {
      setUploadStatus({ type: "error", message: validationError });
      return;
    }
    setMetadataFile(selectedFile);
  };

  const getPresignedUpload = async (
    token: string,
    file: File,
    uploadType: "csv" | "json"
  ): Promise<PresignedUploadResponse> => {
    const res = await fetch(
      `${import.meta.env.VITE_API_ENDPOINT}/admin/generate-presigned-url?file_name=${encodeURIComponent(
        file.name
      )}&content_type=${encodeURIComponent(
        file.type || (uploadType === "csv" ? "text/csv" : "application/json")
      )}`,
      {
        headers: {
          Authorization: token,
        },
      }
    );

    if (!res.ok) {
      throw new Error(`Failed to generate upload URL for ${file.name}`);
    }

    return (await res.json()) as PresignedUploadResponse;
  };

  const uploadFileToS3 = async (presignedUrl: string, file: File, fallbackContentType: string) => {
    const uploadResponse = await fetch(presignedUrl, {
      method: "PUT",
      headers: {
        "Content-Type": file.type || fallbackContentType,
      },
      body: file,
    });

    if (!uploadResponse.ok) {
      throw new Error(`Failed to upload ${file.name} to S3`);
    }
  };

  const resetUploadDialog = () => {
    setIsUploadOpen(false);
    setCsvFile(null);
    setMetadataFile(null);
    setUploadStatus({ type: null, message: "" });
  };

  const handleUpload = async () => {
    if (!csvFile || !metadataFile) {
      setUploadStatus({
        type: "error",
        message: "Please select both the CSV file and the metadata JSON file.",
      });
      return;
    }

    if (!adminEmail) {
      setUploadStatus({
        type: "error",
        message: "Unable to determine the current admin email.",
      });
      return;
    }

    const expectedMetadata = expectedMetadataFileName(csvFile.name);
    if (metadataFile.name !== expectedMetadata) {
      setUploadStatus({
        type: "error",
        message: `Metadata file name must be exactly ${expectedMetadata}`,
      });
      return;
    }

    try {
      setUploading(true);
      setUploadStatus({ type: null, message: "" });

      const session = await AuthService.getAuthSession(true);
      const token = session.tokens.idToken;

      const csvUpload = await getPresignedUpload(token, csvFile, "csv");
      await uploadFileToS3(csvUpload.presignedUrl, csvFile, "text/csv");

      const metadataUpload = await getPresignedUpload(token, metadataFile, "json");
      await uploadFileToS3(metadataUpload.presignedUrl, metadataFile, "application/json");

      const ingestResponse = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/admin/data_sources/csv`,
        {
          method: "POST",
          headers: {
            Authorization: token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            csv_file_name: csvFile.name,
            csv_s3_bucket: csvUpload.bucket,
            csv_s3_key: csvUpload.key,
            metadata_file_name: metadataFile.name,
            metadata_s3_bucket: metadataUpload.bucket,
            metadata_s3_key: metadataUpload.key,
            created_by: adminEmail,
          }),
        }
      );

      const responseJson = await ingestResponse.json().catch(() => ({}));

      if (!ingestResponse.ok) {
        throw new Error(
          responseJson?.error ||
            responseJson?.message ||
            "Upload succeeded but ingestion could not be started."
        );
      }

      setUploadStatus({
        type: "success",
        message:
          responseJson?.message ||
          "CSV and metadata uploaded successfully. Processing started.",
      });

      await fetchAdminDataSources();

      setTimeout(() => {
        resetUploadDialog();
      }, 1200);
    } catch (err) {
      console.error("Upload error:", err);
      setUploadStatus({
        type: "error",
        message: err instanceof Error ? err.message : "Upload failed",
      });
    } finally {
      setUploading(false);
    }
  };

  const latestRunBySourceId = (() => {
    const map = new Map<string, IngestionRunRow>();
    for (const r of ingestionRuns) {
      const existing = map.get(r.data_source_id);
      const a = existing?.created_at ? new Date(existing.created_at).getTime() : 0;
      const b = r.created_at ? new Date(r.created_at).getTime() : 0;
      if (!existing || b > a) map.set(r.data_source_id, r);
    }
    return map;
  })();

  // For CSV -> JSON pairing: "alumni_data_final.csv" -> find "alumni_data_final.csv.metadata.json"
  const jsonByCsvName = (() => {
    const map = new Map<string, DataSourceRow>();
    for (const ds of dataSources) {
      if (ds.type === "json" && ds.name.endsWith(".metadata.json")) {
        const base = ds.name.replace(".metadata.json", "");
        map.set(base, ds);
      }
    }
    return map;
  })();

  // hide JSON rows from main table (they appear as subrow under CSV)
  const filteredDataSources = dataSources
    .filter((ds) => ds.type !== "json")
    .filter((ds) => {
      if (!searchQuery.trim()) return true;
      const q = searchQuery.trim().toLowerCase();
      return (
        ds.name.toLowerCase().includes(q) || ds.type.toLowerCase().includes(q)
      );
    });

  const totalPages = Math.max(1, Math.ceil(filteredDataSources.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const startIdx = (currentPage - 1) * PAGE_SIZE;
  const pagedDataSources = filteredDataSources.slice(startIdx, startIdx + PAGE_SIZE);

  return (
    <div className="space-y-8 max-w-7xl mx-auto animate-in fade-in duration-500">
      <div>
        <h2 className="text-3xl font-bold text-gray-900">Admin Dashboard</h2>
        <p className="text-gray-500 mt-1">
          Manage your data sources and platform overview.
        </p>
      </div>

      {/* Error Message */}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
          <p className="font-medium">Error loading data</p>
          <p className="text-sm">{error}</p>
        </div>
      )}

      {/* Metrics Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <MetricCard
          title="Total Users"
          value={loading ? "..." : totals.users.toLocaleString()}
          icon={<Users className="h-5 w-5 text-primary" />}
          trend="Unique users"
          tooltip="Calculated by counting distinct users with chat sessions."
        />

        <MetricCard
          title="Total Chat sessions"
          value={loading ? "..." : totals.chat_sessions.toLocaleString()}
          icon={<MessageCircleMore className="h-5 w-5 text-primary" />}
          trend="Total Chat sessions"
          tooltip="Total chat sessions across all users."
        />

        <MetricCard
          title="Total Messages"
          value={loading ? "..." : totals.messages.toLocaleString()}
          icon={<HelpCircle className="h-5 w-5 text-[#3d7a9a]" />}
          trend="Total Messages Exchanged"
          tooltip="Total chat messages exchanged across all sessions."
        />
      </div>

      {/* Data Source Management Section */}
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <h3 className="text-xl font-semibold text-gray-900">
            Data Sources
          </h3>
          <div className="flex gap-2">
            {/* Add Web URL Button and Dialog */}
            <Dialog open={isUrlDialogOpen} onOpenChange={setIsUrlDialogOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" className="bg-primary text-white">
                  Add Web URL
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-md">
                <DialogHeader>
                  <DialogTitle>Add Web URL</DialogTitle>
                  <DialogDescription>
                    Enter the URL of the web resource you want to add as a data source.
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                  <div className="space-y-2">
                    <div className="text-sm font-medium text-gray-900">Web URL</div>
                    <Input
                      type="url"
                      placeholder="https://example.com/resource"
                      value={webUrl}
                      onChange={(e) => {
                        setWebUrl(e.target.value);
                        setWebUrlStatus({ type: null, message: "" });
                      }}
                    />
                  </div>

                  <div className="space-y-2">
                    <div className="text-sm font-medium text-gray-900">Include patterns</div>
                    <div className="text-xs text-gray-500">
                      Optional. One regex per line.
                    </div>
                    <textarea
                      value={includePatternsText}
                      onChange={(e) => setIncludePatternsText(e.target.value)}
                      placeholder="^https:\/\/example\.com\/science\/.*"
                      className="min-h-[96px] w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm font-mono"
                    />
                  </div>

                  <div className="space-y-2">
                    <div className="text-sm font-medium text-gray-900">Exclude patterns</div>
                    <div className="text-xs text-gray-500">
                      Optional. One regex per line.
                    </div>
                    <textarea
                      value={excludePatternsText}
                      onChange={(e) => setExcludePatternsText(e.target.value)}
                      placeholder="^https:\/\/example\.com\/science\/private\/.*"
                      className="min-h-[96px] w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm font-mono"
                    />
                  </div>

                  {webUrlStatus.message && (
                    <div
                      className={`text-sm p-2 rounded ${
                        webUrlStatus.type === "success"
                          ? "bg-green-100 text-green-700"
                          : "bg-red-100 text-red-700"
                      }`}
                    >
                      {webUrlStatus.message}
                    </div>
                  )}
                </div>
                <DialogFooter>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setIsUrlDialogOpen(false);
                      setWebUrl("");
                      setIncludePatternsText("");
                      setExcludePatternsText("");
                      setWebUrlStatus({ type: null, message: "" });
                    }}
                  >
                    Cancel
                  </Button>
                  <Button onClick={handleAddWebUrl} disabled={!webUrl || addingUrl}>
                    {addingUrl ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Adding...
                      </>
                    ) : (
                      "Add URL"
                    )}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <Dialog open={isUploadOpen} onOpenChange={setIsUploadOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" className="bg-primary text-white">
                  <Upload className="mr-2 h-4 w-4" />
                  Add Alumni Data (CSV)
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-2xl">
                <DialogHeader>
                  <DialogTitle>Upload Alumni Data</DialogTitle>
                  <DialogDescription>
                    Upload the alumni <span className="font-medium">CSV</span> and its corresponding{" "}
                    <span className="font-medium">metadata JSON</span>. Max size 50MB each.
                  </DialogDescription>
                </DialogHeader>

                <div className="grid gap-4 py-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <div className="text-sm font-medium text-gray-900">CSV file</div>

                      {!csvFile ? (
                        <div
                          className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center hover:bg-gray-50 transition-colors cursor-pointer"
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={(e) => {
                            e.preventDefault();
                            const droppedFile = e.dataTransfer.files?.[0];
                            if (droppedFile) handleCsvFileSelect(droppedFile);
                          }}
                          onClick={() => document.getElementById("csv-upload")?.click()}
                        >
                          <div className="flex flex-col items-center gap-2">
                            <Upload className="h-8 w-8 text-gray-400" />
                            <span className="text-sm font-medium text-gray-600">
                              Drag and drop CSV
                            </span>
                            <span className="text-xs text-gray-400">
                              or click to browse
                            </span>
                          </div>
                          <Input
                            id="csv-upload"
                            type="file"
                            className="hidden"
                            accept=".csv,text/csv"
                            onChange={(e) => {
                              const selectedFile = e.target.files?.[0];
                              if (selectedFile) handleCsvFileSelect(selectedFile);
                            }}
                          />
                        </div>
                      ) : (
                        <div className="border rounded-lg p-4 bg-gray-50">
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2 overflow-hidden">
                              <FileText className="h-5 w-5 text-primary flex-shrink-0" />
                              <span className="text-sm font-medium truncate">{csvFile.name}</span>
                            </div>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 w-6 p-0 text-gray-500 hover:text-red-600"
                              onClick={() => setCsvFile(null)}
                              disabled={uploading}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                          <div className="text-xs text-gray-500">{formatSizeMb(csvFile)}</div>
                        </div>
                      )}
                    </div>

                    <div className="space-y-2">
                      <div className="text-sm font-medium text-gray-900">Metadata JSON file</div>

                      {!metadataFile ? (
                        <div
                          className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center hover:bg-gray-50 transition-colors cursor-pointer"
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={(e) => {
                            e.preventDefault();
                            const droppedFile = e.dataTransfer.files?.[0];
                            if (droppedFile) handleMetadataFileSelect(droppedFile);
                          }}
                          onClick={() => document.getElementById("metadata-upload")?.click()}
                        >
                          <div className="flex flex-col items-center gap-2">
                            <Upload className="h-8 w-8 text-gray-400" />
                            <span className="text-sm font-medium text-gray-600">
                              Drag and drop metadata JSON
                            </span>
                            <span className="text-xs text-gray-400">
                              or click to browse
                            </span>
                          </div>
                          <Input
                            id="metadata-upload"
                            type="file"
                            className="hidden"
                            accept=".json,application/json,text/json"
                            onChange={(e) => {
                              const selectedFile = e.target.files?.[0];
                              if (selectedFile) handleMetadataFileSelect(selectedFile);
                            }}
                          />
                        </div>
                      ) : (
                        <div className="border rounded-lg p-4 bg-gray-50">
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2 overflow-hidden">
                              <FileText className="h-5 w-5 text-primary flex-shrink-0" />
                              <span className="text-sm font-medium truncate">{metadataFile.name}</span>
                            </div>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 w-6 p-0 text-gray-500 hover:text-red-600"
                              onClick={() => setMetadataFile(null)}
                              disabled={uploading}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                          <div className="text-xs text-gray-500">{formatSizeMb(metadataFile)}</div>
                        </div>
                      )}
                    </div>
                  </div>

                  {csvFile && (
                    <div className="text-xs text-gray-600">
                      Expected metadata filename:{" "}
                      <code className="bg-gray-100 px-1 py-0.5 rounded">
                        {expectedMetadataFileName(csvFile.name)}
                      </code>
                    </div>
                  )}

                  {uploadStatus.message && (
                    <div
                      className={`text-sm p-2 rounded ${
                        uploadStatus.type === "success"
                          ? "bg-green-100 text-green-700"
                          : "bg-red-100 text-red-700"
                      }`}
                    >
                      {uploadStatus.message}
                    </div>
                  )}

                  <div className="space-y-3 text-xs">
                    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="h-4 w-4 text-amber-700 mt-0.5" />
                        <div className="text-amber-800">
                          <div className="font-semibold">Two files are required</div>
                          <div className="mt-1 text-amber-700">
                            1) The <span className="font-medium">CSV</span> file
                            <br />
                            2) A matching <span className="font-medium">metadata JSON</span> file
                            with the exact name{" "}
                            <code className="bg-white/70 px-1 py-0.5 rounded border border-amber-200">
                              {"<csv-file-name>.metadata.json"}
                            </code>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="text-gray-500">
                      <p className="font-medium mb-1 text-gray-700">Required CSV Columns:</p>
                      <code className="bg-gray-100 px-1 py-0.5 rounded">
                        Profile, Headline, Year, Degree
                      </code>
                    </div>

                    <div className="text-gray-500">
                      <p className="font-medium mb-1 text-gray-700">Metadata JSON should include:</p>
                      <code className="bg-gray-100 px-1 py-0.5 rounded">
                        size_bytes, storage_class, schema_version, columns, source
                      </code>
                    </div>
                  </div>
                </div>

                <DialogFooter>
                  <Button
                    variant="outline"
                    onClick={resetUploadDialog}
                    disabled={uploading}
                  >
                    Cancel
                  </Button>
                  <Button
                    className="bg-primary hover:bg-primary/90"
                    onClick={handleUpload}
                    disabled={!csvFile || !metadataFile || uploading}
                  >
                    {uploading ? (
                      <>
                        <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                        Uploading...
                      </>
                    ) : (
                      "Upload & Process"
                    )}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </div>

        <Card className="border-gray-200 shadow-sm">
          <CardHeader className="pb-3">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-500" />
              <Input
                placeholder="Search your Sources"
                className="pl-9 max-w-md bg-gray-50 border-gray-200"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader className="bg-gray-50">
                <TableRow>
                  <TableHead className="w-[45%]">Name</TableHead>
                  <TableHead className="w-[10%]">Type</TableHead>
                  <TableHead className="w-[12%]">Status</TableHead>
                  <TableHead className="w-[16%]">Uploaded</TableHead>
                  <TableHead className="w-[16%]">Ingested</TableHead>
                  <TableHead className="w-[8%] text-right">Delete</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={6} className="py-10">
                      <div className="flex items-center justify-center gap-2 text-gray-500">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>Loading data sources...</span>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : pagedDataSources.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-10 text-gray-500">
                      No data sources found.
                    </TableCell>
                  </TableRow>
                ) : (
                  pagedDataSources.map((ds) => {
                    const run = latestRunBySourceId.get(ds.id);
                    const status = run?.status ?? "no_runs";
                    const isExpandable =
                      ds.type === "website" ||
                      (ds.type === "csv" && !!jsonByCsvName.get(ds.name));
                    const isOpen = !!expanded[ds.id];

                    return (
                      <>
                        <TableRow key={ds.id} className={isOpen ? "bg-gray-50/50" : ""}>
                          <TableCell className="align-top">
                            <div className="flex items-start gap-2">
                              {isExpandable ? (
                                <button
                                  type="button"
                                  className="mt-0.5 text-xs rounded border border-gray-200 px-2 py-1 text-gray-600 hover:bg-gray-50"
                                  onClick={() =>
                                    setExpanded((prev) => ({ ...prev, [ds.id]: !prev[ds.id] }))
                                  }
                                  title={isOpen ? "Hide details" : "Show details"}
                                >
                                  {isOpen ? "Hide" : "Details"}
                                </button>
                              ) : (
                                <span className="mt-0.5 text-xs rounded border border-gray-200 px-2 py-1 text-gray-400">
                                  —
                                </span>
                              )}

                              <div className="min-w-0">
                                <div className="font-medium text-gray-900 break-all">
                                  {ds.name}
                                </div>
                              </div>
                            </div>
                          </TableCell>

                          <TableCell className="align-top">
                            <Badge variant="secondary">{typeLabel(ds.type)}</Badge>
                          </TableCell>

                          <TableCell className="align-top">{statusBadge(status)}</TableCell>

                          <TableCell className="align-top text-sm text-gray-700">
                            {formatDateTime(ds.created_at)}
                          </TableCell>

                          <TableCell className="align-top text-sm text-gray-700">
                            {formatDateTime(run?.completed_at ?? null)}
                          </TableCell>

                          <TableCell className="align-top text-right">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-red-500"
                              disabled
                              title="Delete (mock)"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </TableCell>
                        </TableRow>

                        {/* Subrow */}
                        {isOpen ? (
                          <TableRow key={`${ds.id}-sub`}>
                            <TableCell colSpan={6} className="bg-gray-50/70">
                              {ds.type === "website" ? (
                                <div className="space-y-3">
                                  <div className="text-sm font-medium text-gray-800">
                                    Crawl rules
                                  </div>

                                  {(ds.include_patterns?.length ?? 0) > 0 ? (
                                    <div>
                                      <div className="text-xs font-semibold text-gray-600 mb-1">
                                        Include patterns
                                      </div>
                                      <div className="text-xs font-mono bg-white border border-gray-200 rounded p-3 overflow-auto">
                                        {(ds.include_patterns ?? []).map((p, i) => (
                                          <div key={i} className="break-all">
                                            {p}
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  ) : (
                                    <div className="text-xs text-gray-500">
                                      No include patterns.
                                    </div>
                                  )}

                                  {(ds.exclude_patterns?.length ?? 0) > 0 ? (
                                    <div>
                                      <div className="text-xs font-semibold text-gray-600 mb-1">
                                        Exclude patterns
                                      </div>
                                      <div className="text-xs font-mono bg-white border border-gray-200 rounded p-3 overflow-auto">
                                        {(ds.exclude_patterns ?? []).map((p, i) => (
                                          <div key={i} className="break-all">
                                            {p}
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  ) : (
                                    <div className="text-xs text-gray-500">
                                      No exclude patterns.
                                    </div>
                                  )}
                                </div>
                              ) : ds.type === "csv" ? (
                                (() => {

                                  const json = jsonByCsvName.get(ds.name);
                                  const jsonRun = json ? latestRunBySourceId.get(json.id) : undefined;
                                  const jsonStatus = jsonRun?.status ?? "no_runs";

                                  return (
                                    <div className="space-y-5">

                                      {/* JSON "child row" summary (mirrors main table columns) */}
                                      <div className="space-y-2">
                                        <div className="text-sm font-medium text-gray-800">
                                          Metadata JSON file
                                        </div>

                                        {json ? (
                                          <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
                                            <div className="grid grid-cols-12 gap-2 px-3 py-3 text-sm items-start">
                                              <div className="col-span-6 min-w-0">
                                                <div className="text-gray-900 break-all font-medium">
                                                  {json.name}
                                                </div>
                                              </div>

                                              <div className="col-span-1">
                                                <Badge variant="secondary">{typeLabel(json.type)}</Badge>
                                              </div>

                                              <div className="col-span-1">{statusBadge(jsonStatus)}</div>

                                              <div className="col-span-2 text-xs text-gray-700">
                                                {formatDateTime(json.created_at)}
                                              </div>

                                              <div className="col-span-1 text-xs text-gray-700">
                                                {formatDateTime(jsonRun?.completed_at ?? null)}
                                              </div>

                                              <div className="col-span-1 flex justify-end">
                                                <Button
                                                  variant="ghost"
                                                  size="icon"
                                                  className="h-8 w-8 text-red-500"
                                                  disabled
                                                  title="Delete (mock)"
                                                >
                                                  <Trash2 className="h-4 w-4" />
                                                </Button>
                                              </div>
                                            </div>
                                          </div>
                                        ) : (
                                          <div className="text-xs text-gray-500">
                                            No metadata JSON found for this CSV.
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  );
                                })()
                              ) : (
                                <div className="text-xs text-gray-500">No details.</div>
                              )}
                            </TableCell>
                          </TableRow>
                        ) : null}
                      </>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </CardContent>

          {/* Client-side Pagination Controls */}
          {!loading && filteredDataSources.length > 0 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200">
              <div className="text-sm text-gray-600">
                Showing <span className="font-medium">{Math.min(startIdx + 1, filteredDataSources.length)}</span> to{" "}
                <span className="font-medium">{Math.min(startIdx + PAGE_SIZE, filteredDataSources.length)}</span> of{" "}
                <span className="font-medium">{filteredDataSources.length}</span>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                >
                  Prev
                </Button>

                <div className="text-sm text-gray-700">
                  Page <span className="font-medium">{currentPage}</span> of{" "}
                  <span className="font-medium">{totalPages}</span>
                </div>

                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
