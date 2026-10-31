import type { AnchorHTMLAttributes, ImgHTMLAttributes, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ImageOff } from 'lucide-react';
import { useFileUrl } from '@/hooks/useFileTokens';
import { ImageLightbox } from './ImageLightbox';

// 파일 URL은 파일별 토큰이 있어야 만들어진다. 토큰이 없을 때(받는 중/접근 불가)는 URL 없이 자리표시자를 그린다.
// 구독이 파일 단위라 토큰이 바뀌어도 이 작은 컴포넌트만 다시 그려진다.

function Placeholder({ denied, className }: { denied: boolean; className?: string }) {
  const { t } = useTranslation('messages');
  return denied ? (
    <span
      role="img"
      aria-label={t('files.unavailable')}
      title={t('files.unavailable')}
      data-testid="file-unavailable"
      className={`inline-flex items-center justify-center bg-slack-hover text-slack-disabled ${className ?? ''}`}
    >
      <ImageOff className="h-5 w-5" />
    </span>
  ) : (
    <span
      aria-busy="true"
      aria-label={t('files.preparing')}
      data-testid="file-pending"
      className={`inline-block animate-pulse bg-slack-hover ${className ?? ''}`}
    />
  );
}

export function AuthFileImage({ fileId, alt, className, ...rest }: { fileId: number; alt: string } & Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'alt'>) {
  const { url, denied } = useFileUrl(fileId);
  if (!url) return <Placeholder denied={denied} className={`${className ?? ''} min-h-10 min-w-10`} />;
  return <img src={url} alt={alt} className={className} {...rest} />;
}

export function AuthFileMedia({ kind, fileId, className, ...rest }: { kind: 'audio' | 'video'; fileId: number; className?: string } & Record<string, unknown>) {
  const { url, denied } = useFileUrl(fileId);
  if (!url) return <Placeholder denied={denied} className={`${className ?? ''} min-h-8 min-w-24`} />;
  const Tag = kind;
  return <Tag src={url} className={className} {...rest} />;
}

interface AuthFileLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  fileId: number;
  forceDownload?: boolean;
  children: ReactNode;
}

/** 다운로드·열기 링크. 토큰이 없으면 비활성(aria-disabled) 표시만 한다. */
export function AuthFileLink({ fileId, forceDownload = false, children, className, onClick, ...rest }: AuthFileLinkProps) {
  const { url } = useFileUrl(fileId, { download: forceDownload });
  if (!url) {
    return (
      <span aria-disabled="true" className={`${className ?? ''} cursor-not-allowed opacity-40`} onClick={onClick as never}>
        {children}
      </span>
    );
  }
  return <a href={url} className={className} onClick={onClick} {...rest}>{children}</a>;
}

/** 라이트박스: 상태에는 fileId만 두고 URL은 렌더할 때마다 계산한다. */
export function AuthFileLightbox({ fileId, alt, onClose }: { fileId: number; alt: string; onClose: () => void }) {
  const { url } = useFileUrl(fileId);
  if (!url) return null;
  return <ImageLightbox src={url} alt={alt} onClose={onClose} />;
}
