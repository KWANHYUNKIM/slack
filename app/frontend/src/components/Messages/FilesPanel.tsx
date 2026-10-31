import { useState, useEffect } from 'react';
import { FileText, Download } from 'lucide-react';
import { AuthFileImage, AuthFileLink, AuthFileLightbox } from './AuthFile';
import { useTranslation } from 'react-i18next';
import { formatDate, DATE_MEDIUM } from '@/lib/i18n/format';
import { getChannelFiles, getUserFiles, type ApiFileWithUser } from '@/lib/api';
import { PanelHeader } from './PanelHeader';
import { formatBytes } from '@/lib/fileUtils';
import { FileIcon } from './FileIcon';

interface FilesPanelProps {
  channelId?: number;
  onClose: () => void;
  title?: string;
}


export function FilesPanel({ channelId, onClose, title }: FilesPanelProps) {
  const { t } = useTranslation(['messages', 'common']);
  const [files, setFiles] = useState<ApiFileWithUser[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lightboxFileId, setLightboxFileId] = useState<number | null>(null);
  const [lightboxAlt, setLightboxAlt] = useState('');

  useEffect(() => {
    let cancelled = false;
    const fetchFn = channelId ? getChannelFiles(channelId) : getUserFiles();
    fetchFn
      .then((data) => {
        if (cancelled) return;
        setFiles(data);
        setLoadError(null);
      })
      .catch(() => {
        if (!cancelled) setLoadError(t('messages:files.loadFailed'));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [channelId, t]);

  const panelTitle = title ?? (channelId ? t('messages:files.channelFiles') : t('messages:files.allFiles'));

  return (
    <div data-testid="files-panel" className="flex w-full md:w-[300px] flex-col border-s border-slack-border bg-white absolute inset-0 md:static md:inset-auto z-30 md:z-auto">
      <PanelHeader icon={FileText} title={panelTitle} onClose={onClose} />
      <div className="flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
        {isLoading ? (
          <div className="p-4 text-center text-sm text-slack-hint">{t('common:status.loading')}</div>
        ) : loadError ? (
          <div className="p-4 text-center text-sm text-slack-error">{loadError}</div>
        ) : files.length === 0 ? (
          <div className="p-4 text-center text-sm text-slack-hint">{t('messages:files.empty')}</div>
        ) : (
          files.map((file) => (
            <div key={file.id} className="border-b border-slack-border-light px-4 py-3">
              {file.mimetype.startsWith('image/') ? (
                <button
                  onClick={() => { setLightboxFileId(file.id); setLightboxAlt(file.originalName); }}
                  className="block mb-2 w-full cursor-zoom-in focus:outline-none"
                >
                  <AuthFileImage
                    fileId={file.id}
                    alt={file.originalName}
                    className="w-full max-h-[140px] rounded object-cover"
                  />
                </button>
              ) : null}
              <div className="flex items-start gap-2">
                <div className="mt-0.5 flex-shrink-0">
                  <FileIcon mimetype={file.mimetype} />
                </div>
                <div className="flex-1 min-w-0">
                  {file.mimetype.startsWith('image/') ? (
                    <button
                      onClick={() => { setLightboxFileId(file.id); setLightboxAlt(file.originalName); }}
                      className="block text-[13px] font-medium text-slack-link hover:underline truncate text-start"
                    >
                      {file.originalName}
                    </button>
                  ) : (
                    <AuthFileLink
                      fileId={file.id}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block text-[13px] font-medium text-slack-link hover:underline truncate"
                    >
                      {file.originalName}
                    </AuthFileLink>
                  )}
                  <p className="text-[11px] text-slack-secondary">
                    {formatBytes(file.size)} &middot; {file.user.name} &middot;{' '}
                    {formatDate(file.createdAt, DATE_MEDIUM)}
                  </p>
                </div>
                <AuthFileLink
                  fileId={file.id} forceDownload
                  download={file.originalName.replace(/[/\\:\0]/g, '_')} rel="noopener"
                  className="flex-shrink-0 flex h-6 w-6 items-center justify-center rounded hover:bg-slack-hover"
                  title={t('messages:files.download')}
                >
                  <Download className="h-3.5 w-3.5 text-slack-secondary" />
                </AuthFileLink>
              </div>
            </div>
          ))
        )}
      </div>

      {lightboxFileId !== null && (
        <AuthFileLightbox fileId={lightboxFileId} alt={lightboxAlt} onClose={() => setLightboxFileId(null)} />
      )}
    </div>
  );
}
