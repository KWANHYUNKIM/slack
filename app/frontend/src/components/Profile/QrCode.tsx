import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { encodeQr } from '@/lib/qr/encode';

interface QrCodeProps {
  value: string;
  /** 화면에 그릴 한 변 길이(px) */
  size?: number;
}

const QUIET_ZONE = 4; // 규격이 요구하는 여백(모듈 수)

// QR을 SVG로 그린다. 스캔 가능성을 위해 다크 모드에서도 흰 배경 + 검은 모듈을 유지한다.
// QR은 좌우 방향이 뜻을 가지므로 RTL에서도 뒤집지 않는다(dir="ltr" 고정).
export function QrCode({ value, size = 176 }: QrCodeProps) {
  const { t } = useTranslation('settings');
  const qr = useMemo(() => {
    try {
      return encodeQr(value);
    } catch {
      return null; // 너무 길면 그리지 않는다(링크와 키는 그대로 보인다)
    }
  }, [value]);
  if (!qr) return null;

  const total = qr.size + QUIET_ZONE * 2;
  let d = '';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y][x]) d += `M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`;
    }
  }
  return (
    <div dir="ltr" data-testid="mfa-setup-qr" className="inline-block rounded-md border border-slack-border bg-white">
      <svg
        role="img"
        aria-label={t('twoFactor.setup.qrLabel')}
        viewBox={`0 0 ${total} ${total}`}
        width={size}
        height={size}
        shapeRendering="crispEdges"
      >
        <rect width={total} height={total} fill="#ffffff" />
        <path d={d} fill="#000000" />
      </svg>
    </div>
  );
}
