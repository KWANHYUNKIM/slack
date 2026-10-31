import * as React from 'react';
import { Moon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { UserStatus } from '@/lib/types';

interface AvatarProps extends React.HTMLAttributes<HTMLDivElement> {
  src?: string | null;
  alt?: string;
  fallback?: string;
  size?: 'sm' | 'md' | 'lg';
  status?: UserStatus;
  /** 커스텀 상태 이모지(05). 아바타 모서리에 붙는다. */
  statusEmoji?: string | null;
  /** 방해금지 중이면 달 표시를 얹는다. 프레즌스 점은 바꾸지 않는다. */
  dnd?: boolean;
}

const sizeClasses = {
  sm: 'h-5 w-5 text-xs',
  md: 'h-9 w-9 text-sm',
  lg: 'h-12 w-12 text-base',
};

const statusColors = {
  online: 'bg-green-500',
  away: 'bg-yellow-500',
  dnd: 'bg-red-500',
  offline: 'bg-gray-400',
};

const Avatar = React.forwardRef<HTMLDivElement, AvatarProps>(
  ({ className, src, alt, fallback, size = 'md', status, statusEmoji, dnd, ...props }, ref) => {
    const { t } = useTranslation('settings');
    const [imageError, setImageError] = React.useState(false);
    const imgRef = React.useRef<HTMLImageElement>(null);

    // Reset error state when src changes
    React.useEffect(() => {
      setImageError(false);
    }, [src]);

    // Catch cached broken images (complete=true but naturalWidth=0)
    React.useEffect(() => {
      const img = imgRef.current;
      if (img && img.complete && img.naturalWidth === 0) {
        setImageError(true);
      }
    }, [src, imageError]);

    const initials = fallback
      ? fallback
          .split(' ')
          .map((n) => n[0])
          .join('')
          .toUpperCase()
          .slice(0, 2)
      : '?';

    return (
      <div className="relative inline-flex" ref={ref} {...props}>
        <div
          className={cn(
            'relative flex shrink-0 overflow-hidden bg-gray-200',
            size === 'sm' ? 'rounded-[4px]' : 'rounded-lg',
            sizeClasses[size],
            className
          )}
        >
          {src && !imageError ? (
            <img
              ref={imgRef}
              src={src}
              alt={alt || t('avatar.alt')}
              className="aspect-square h-full w-full object-cover"
              onError={() => setImageError(true)}
              onLoad={(e) => {
                if ((e.target as HTMLImageElement).naturalWidth === 0) setImageError(true);
              }}
            />
          ) : (
            <span className="flex h-full w-full items-center justify-center bg-slack-aubergine text-white font-medium">
              {initials}
            </span>
          )}
        </div>
        {statusEmoji && size !== 'sm' && (
          <span
            data-testid="avatar-status-emoji"
            className="absolute -top-1 -end-1 flex h-4 w-4 items-center justify-center rounded-full bg-white text-[11px] leading-none shadow"
            aria-hidden="true"
          >
            {statusEmoji}
          </span>
        )}
        {dnd && size !== 'sm' && (
          <span
            data-testid="avatar-dnd-icon"
            className="absolute -bottom-1 -start-1 flex h-4 w-4 items-center justify-center rounded-full bg-white text-slack-hint shadow"
            title={t('avatar.dnd')}
          >
            <Moon className="h-3 w-3" aria-label={t('avatar.dnd')} />
          </span>
        )}
        {status && (
          <span
            className={cn(
              'absolute bottom-0 end-0 block rounded-full ring-2 ring-white',
              statusColors[status],
              size === 'sm' ? 'h-2 w-2' : size === 'md' ? 'h-3 w-3' : 'h-4 w-4'
            )}
          />
        )}
      </div>
    );
  }
);
Avatar.displayName = 'Avatar';

export { Avatar };
