import { useTranslation } from 'react-i18next';
import { Copy, Download } from 'lucide-react';
import { useToastStore } from '@/stores/useToastStore';

interface RecoveryCodesPanelProps {
  codes: string[];
  onDone: () => void;
}

// 복구 코드(E7b): 켠 직후 한 번만 보여 준다. 다운로드는 서버를 거치지 않고 브라우저에서 만든 파일(blob)이다.
export function RecoveryCodesPanel({ codes, onDone }: RecoveryCodesPanelProps) {
  const { t } = useTranslation('settings');
  const showToast = useToastStore((s) => s.show);
  const text = `${t('twoFactor.recovery.fileHeader')}\n\n${codes.join('\n')}\n`;

  const handleDownload = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    // 파일 이름도 번역한다. 글자·숫자·점·밑줄·하이픈 말고는(경로 구분자, 공백, 제어 문자 등) 하이픈으로 바꾼다.
    a.download = t('twoFactor.recovery.fileName').replace(/[^\p{L}\p{N}._-]/gu, '-') || 'recovery-codes.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      showToast(t('twoFactor.setup.copied'));
    } catch {
      showToast(t('twoFactor.errors.copyFailed'));
    }
  };

  return (
    <div data-testid="mfa-recovery-codes" className="rounded-md border border-amber-300 bg-amber-50 p-3">
      <p className="mb-1 text-[14px] font-bold text-slack-primary">{t('twoFactor.recovery.title')}</p>
      <p className="mb-3 text-[13px] text-slack-secondary">{t('twoFactor.recovery.description')}</p>
      <ul className="mb-3 grid grid-cols-2 gap-x-4 gap-y-1 rounded bg-white p-3 font-mono text-[13px]" dir="ltr">
        {codes.map((c) => <li key={c} data-testid="mfa-recovery-code">{c}</li>)}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleDownload}
          className="flex items-center gap-1.5 rounded-md border border-slack-border bg-white px-3 py-1.5 text-[13px] font-medium text-slack-primary hover:bg-slack-hover"
        >
          <Download className="h-4 w-4" />
          {t('twoFactor.recovery.download')}
        </button>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1.5 rounded-md border border-slack-border bg-white px-3 py-1.5 text-[13px] font-medium text-slack-primary hover:bg-slack-hover"
        >
          <Copy className="h-4 w-4" />
          {t('twoFactor.recovery.copy')}
        </button>
        <button
          type="button"
          data-testid="mfa-recovery-done"
          onClick={onDone}
          className="ms-auto rounded-md bg-slack-aubergine px-4 py-1.5 text-[13px] font-medium text-white"
        >
          {t('twoFactor.recovery.confirmSaved')}
        </button>
      </div>
    </div>
  );
}
