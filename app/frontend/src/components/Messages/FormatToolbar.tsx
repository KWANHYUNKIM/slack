import {
  Bold,
  Italic,
  Strikethrough,
  Link,
  ListOrdered,
  List,
  Code,
  CodeSquare,
  Quote,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

const formatButtons = [
  { icon: Bold, key: 'bold', format: 'bold' },
  { icon: Italic, key: 'italic', format: 'italic' },
  { icon: Strikethrough, key: 'strike', format: 'strike' },
  { icon: Link, key: 'link', format: 'link' },
  { icon: ListOrdered, key: 'orderedList', format: 'list', value: 'ordered' },
  { icon: List, key: 'bulletList', format: 'list', value: 'bullet' },
  { icon: Code, key: 'code', format: 'code' },
  { icon: CodeSquare, key: 'codeBlock', format: 'code-block' },
  { icon: Quote, key: 'quote', format: 'blockquote' },
];

interface FormatToolbarProps {
  onApplyFormat: (format: string, value?: string) => void;
}

export function FormatToolbar({ onApplyFormat }: FormatToolbarProps) {
  const { t } = useTranslation('messages');
  return (
    <div
      data-testid="formatting-toolbar"
      className="flex items-center gap-0.5 border-b border-slack-border-light px-1 py-1"
    >
      {formatButtons.map((button) => (
        <Button
          key={button.key}
          variant="toolbar"
          size="icon-sm"
          onClick={() => onApplyFormat(button.format, button.value)}
          title={t(`format.${button.key}`)}
        >
          <button.icon className="h-[18px] w-[18px]" />
        </Button>
      ))}
    </div>
  );
}
