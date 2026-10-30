import { useEffect, useState } from 'react';
import { X, Download, FileText } from 'lucide-react';
import { getFileUrl, getAuthFileUrl } from '@/lib/api';

interface FilePreviewModalProps {
  fileId: number;
  fileName: string;
  fileSize: number;
  mimetype: string;
  onClose: () => void;
}

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'json', 'csv', 'log', 'xml', 'yml', 'yaml', 'toml',
  'ini', 'cfg', 'conf', 'env', 'sh', 'bash', 'zsh',
  'js', 'ts', 'jsx', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h',
  'css', 'scss', 'html', 'svg', 'sql',
]);

function getExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function isTextFile(mimetype: string, fileName: string): boolean {
  if (mimetype.startsWith('text/')) return true;
  if (mimetype === 'application/json' || mimetype === 'application/xml') return true;
  return TEXT_EXTENSIONS.has(getExtension(fileName));
}

function isPdf(mimetype: string): boolean {
  return mimetype === 'application/pdf';
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FilePreviewModal({ fileId, fileName, fileSize, mimetype, onClose }: FilePreviewModalProps) {
  const [textContent, setTextContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fileUrl = getFileUrl(fileId);
  const downloadUrl = getAuthFileUrl(`/files/${fileId}/download`, { download: true });
  const isText = isTextFile(mimetype, fileName);
  const isPdfFile = isPdf(mimetype);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (!isText) return;
    setLoading(true);
    fetch(fileUrl)
      .then((res) => {
        if (!res.ok) throw new Error('Failed to load file');
        return res.text();
      })
      .then((text) => {
        // Cap preview at 100KB to avoid UI freeze
        setTextContent(text.length > 100_000 ? text.slice(0, 100_000) + '\n\n... (truncated)' : text);
        setLoading(false);
      })
      .catch(() => {
        setError('Could not load file content');
        setLoading(false);
      });
  }, [fileUrl, isText]);

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80"
      onClick={onClose}
    >
      <div
        className="relative flex flex-col bg-white rounded-lg shadow-2xl max-w-[90vw] max-h-[90vh] w-[800px]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slack-border">
          <div className="flex items-center gap-2 min-w-0">
            <FileText className="h-5 w-5 text-slack-link flex-shrink-0" />
            <span className="text-[14px] font-semibold text-slack-primary truncate">{fileName}</span>
            <span className="text-[12px] text-slack-disabled flex-shrink-0">{formatFileSize(fileSize)}</span>
          </div>
          <div className="flex items-center gap-2">
            <a
              href={downloadUrl}
              download={fileName.replace(/[/\\:\0]/g, '_')}
              rel="noopener"
              className="flex items-center gap-1 rounded px-2 py-1 text-[13px] text-slack-secondary hover:bg-slack-hover"
            >
              <Download className="h-4 w-4" />
              Download
            </a>
            <button
              onClick={onClose}
              className="flex h-7 w-7 items-center justify-center rounded hover:bg-slack-hover text-slack-secondary"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Preview Content */}
        <div className="flex-1 overflow-auto min-h-[200px]">
          {isPdfFile && (
            <iframe
              src={fileUrl}
              className="w-full h-[80vh] border-0"
              title={fileName}
            />
          )}

          {isText && (
            <div className="p-4">
              {loading && <p className="text-[13px] text-slack-secondary">Loading...</p>}
              {error && <p className="text-[13px] text-red-600">{error}</p>}
              {textContent !== null && (
                <pre className="text-[13px] font-mono leading-relaxed text-slack-primary whitespace-pre-wrap break-words">
                  {textContent}
                </pre>
              )}
            </div>
          )}

          {!isPdfFile && !isText && (
            <div className="flex flex-col items-center justify-center py-16 text-slack-secondary">
              <FileText className="h-12 w-12 mb-3" />
              <p className="text-[14px]">No preview available</p>
              <p className="text-[12px] mt-1">Download the file to view it</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
