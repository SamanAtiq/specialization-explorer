import { useState, useEffect } from "react";
import { useNavigate } from "react-router";
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
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
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

type PaginationInfo = {
  limit: number;
  offset: number;
  total: number;
  hasMore: boolean;
};

export default function DataSourceManagement() {
  const [isUrlDialogOpen, setIsUrlDialogOpen] = useState(false);
  const [webUrl, setWebUrl] = useState("");
  const [webUrlStatus, setWebUrlStatus] = useState<{ type: "success" | "error" | null; message: string }>({ type: null, message: "" });
  const [searchQuery, setSearchQuery] = useState("");
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pagination, setPagination] = useState<PaginationInfo | null>(null);
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<{
    type: "success" | "error" | null;
    message: string;
  }>({ type: null, message: "" });

  const totalUsers = 1;
  const totalMessages = 1;

  const handleFileSelect = (selectedFile: File) => {
    setUploadStatus({ type: null, message: "" });

    // Validate file type
    if (
      !selectedFile.name.endsWith(".csv") &&
      selectedFile.type !== "text/csv"
    ) {
      setUploadStatus({
        type: "error",
        message: "Only CSV files are allowed.",
      });
      return;
    }

    // Validate file size (50MB)
    if (selectedFile.size > 50 * 1024 * 1024) {
      setUploadStatus({
        type: "error",
        message: "File size must be less than 50MB.",
      });
      return;
    }

    setFile(selectedFile);
  };

  const handleUpload = async () => {
    if (!file) return;

    try {
      setUploading(true);
      setUploadStatus({ type: null, message: "" });

      const session = await AuthService.getAuthSession(true);
      const token = session.tokens.idToken;

      // 1. Get pre-signed URL for upload
      const presignedResponse = await fetch(
        `${
          import.meta.env.VITE_API_ENDPOINT
        }/generate-presigned-url?file_name=${encodeURIComponent(
          file.name
        )}&content_type=${encodeURIComponent(
          file.type || "text/csv"
        )}&upload_type=TODO:update`,
        {
          headers: {
            Authorization: token,
          },
        }
      );

      if (!presignedResponse.ok) {
        throw new Error("Failed to generate upload URL");
      }

      const { presignedUrl } = await presignedResponse.json();

      // 2. Upload file to S3
      const uploadResponse = await fetch(presignedUrl, {
        method: "PUT",
        headers: {
          "Content-Type": file.type || "text/csv",
        },
        body: file,
      });

      if (!uploadResponse.ok) {
        throw new Error("Failed to upload file to S3");
      }

      setUploadStatus({
        type: "success",
        message: "File uploaded successfully. Processing started.",
      });

      // Close dialog after a short delay
      setTimeout(() => {
        setIsUploadOpen(false);
        setFile(null);
        setUploadStatus({ type: null, message: "" });
      }, 2000);
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
          value={loading ? "..." : totalUsers.toString()}
          icon={<Users className="h-5 w-5 text-[#2c5f7c]" />}
          trend="Unique users"
          tooltip="Calculated by summing the user count from each browser cookie."
        />
        <MetricCard
          title="Total Chat sessions"
          value={loading ? "..." : totalUsers.toString()}
          icon={<MessageCircleMore className="h-5 w-5 text-[#2c5f7c]" />}
          trend="Total Chat sessions"
          tooltip="Calculated by summing the total chats by all users across all users."
        />
        <MetricCard
          title="Total Messages"
          value={loading ? "..." : totalMessages.toLocaleString()}
          icon={<HelpCircle className="h-5 w-5 text-[#3d7a9a]" />}
          trend="Total Messages Exchanged"
          tooltip="Calculated by summing the message count from each user chat session."
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
                          <Button variant="outline" className="bg-secondary text-white">
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
                            <Input
                              type="url"
                              placeholder="https://example.com/resource"
                              value={webUrl}
                              onChange={e => {
                                setWebUrl(e.target.value);
                                setWebUrlStatus({ type: null, message: "" });
                              }}
                            />
                            {webUrlStatus.message && (
                              <div
                                className={`text-sm p-2 rounded ${webUrlStatus.type === "success" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}
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
                                setWebUrlStatus({ type: null, message: "" });
                              }}
                            >
                              Cancel
                            </Button>
                            <Button
                              className="bg-[#2c5f7c] hover:bg-[#234d63]"
                              onClick={() => {
                                // Basic URL validation
                                if (!webUrl || !/^https?:\/\//.test(webUrl)) {
                                  setWebUrlStatus({ type: "error", message: "Please enter a valid URL (must start with http:// or https://)." });
                                  return;
                                }
                                // TODO: Handle submit (API call or state update)
                                setWebUrlStatus({ type: "success", message: "URL added successfully (not yet implemented)." });
                                setTimeout(() => {
                                  setIsUrlDialogOpen(false);
                                  setWebUrl("");
                                  setWebUrlStatus({ type: null, message: "" });
                                }, 1500);
                              }}
                              disabled={!webUrl}
                            >
                              Add URL
                            </Button>
                          </DialogFooter>
                        </DialogContent>
                      </Dialog>
            <Dialog open={isUploadOpen} onOpenChange={setIsUploadOpen}>
              <DialogTrigger asChild>
                <Button className="bg-secondary text-white">
                  <Upload className="mr-2 h-4 w-4" />
                  Add Alumni Data (CSV)
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-md">
                <DialogHeader>
                  <DialogTitle>Upload Alumni CSV</DialogTitle>
                  <DialogDescription>
                    Upload a detailed CSV file containing alumni metadata. Max size 50MB. 
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                  {!file ? (
                    <div
                      className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center hover:bg-gray-50 transition-colors cursor-pointer"
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        const droppedFile = e.dataTransfer.files[0];
                        if (droppedFile) handleFileSelect(droppedFile);
                      }}
                      onClick={() =>
                        document.getElementById("csv-upload")?.click()
                      }
                    >
                      <div className="flex flex-col items-center gap-2">
                        <Upload className="h-10 w-10 text-gray-400" />
                        <span className="text-sm font-medium text-gray-600">
                          Drag and drop your CSV here
                        </span>
                        <span className="text-xs text-gray-400">
                          or click to browse
                        </span>
                      </div>
                      <Input
                        id="csv-upload"
                        type="file"
                        className="hidden"
                        accept=".csv"
                        onChange={(e) => {
                          const selectedFile = e.target.files?.[0];
                          if (selectedFile) handleFileSelect(selectedFile);
                        }}
                      />
                    </div>
                  ) : (
                    <div className="border rounded-lg p-4 bg-gray-50">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2 overflow-hidden">
                          <FileText className="h-5 w-5 text-[#2c5f7c] flex-shrink-0" />
                          <span className="text-sm font-medium truncate">
                            {file.name}
                          </span>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0 text-gray-500 hover:text-red-600"
                          onClick={() => {
                            setFile(null);
                            setUploadStatus({ type: null, message: "" });
                          }}
                          disabled={uploading}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                      <div className="text-xs text-gray-500 mb-2">
                        {(file.size / (1024 * 1024)).toFixed(2)} MB
                      </div>
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
                    </div>
                  )}

                  <div className="text-xs text-gray-500">
                    <p className="font-medium mb-1">Required CSV Columns:</p>
                    <code className="bg-gray-100 px-1 py-0.5 rounded">
                      Column 1, Column 2, Column 3, Column 4, Column 5...
                    </code>
                  </div>
                </div>
                <DialogFooter>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setIsUploadOpen(false);
                      setFile(null);
                      setUploadStatus({ type: null, message: "" });
                    }}
                    disabled={uploading}
                  >
                    Cancel
                  </Button>
                  <Button
                    className="bg-[#2c5f7c] hover:bg-[#234d63]"
                    onClick={handleUpload}
                    disabled={!file || uploading}
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
                  <TableHead className="w-[40%]">Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Re-ingest</TableHead>
                  <TableHead>Delete</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {/* TODO: having loading logic and call endpoints */}
                {/* {loading ? ( */}
                {false ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-8">
                      <div className="flex items-center justify-center gap-2">
                        <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-[#2c5f7c]"></div>
                        <span className="text-gray-500">
                          Loading data sources...
                        </span>
                      </div>
                    </TableCell>
                  </TableRow>
                ) :
                  <TableRow>
                    <TableCell className="text-black-400 italic">https://example.com/</TableCell>
                    <TableCell className="text-black-400 italic">Web </TableCell>
                    <TableCell className="text-black-400 italic">Successful</TableCell>
                    <TableCell>
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-green-500" disabled>
                        <RefreshCw className="h-4 w-4" />
                      </Button>
                    </TableCell>
                    <TableCell>
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-red-500" disabled>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                }
              </TableBody>
            </Table>
          </CardContent>

          {/* Pagination Controls */}
          {!loading && pagination && (
            "TODO"
          )}
        </Card>
      </div>
    </div>
  );
}
