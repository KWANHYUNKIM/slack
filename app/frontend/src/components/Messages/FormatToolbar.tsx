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
import { Button } from '@/components/ui/button';

const formatButtons = [
  { icon: Bold, label: 'Bold', format: 'bold' },
  { icon: Italic, label: 'Italic', format: 'italic' },
  { icon: Strikethrough, label: 'Strikethrough', format: 'strike' },
  { icon: Link, label: 'Link', format: 'link' },
  { icon: ListOrdered, label: 'Ordered List', format: 'list', value: 'ordered' },
  { icon: List, label: 'Bullet List', format: 'list', value: 'bullet' },
  { icon: Code, label: 'Code', format: 'code' },
  { icon: CodeSquare, label: 'Code Block', format: 'code-block' },
  { icon: Quote, label: 'Quote', format: 'blockquote' },
];

interface FormatToolbarProps {
  onApplyFormat: (format: string, value?: string) => void;
}

export function FormatToolbar({ onApplyFormat }: FormatToolbarProps) {
  return (
    <div
      data-testid="formatting-toolbar"
      className="flex items-center gap-0.5 border-b border-slack-border-light px-1 py-1"
    >
      {formatButtons.map((button) => (
        <Button
          key={button.label}
          variant="toolbar"
          size="icon-sm"
          onClick={() => onApplyFormat(button.format, button.value)}
          title={button.label}
        >
          <button.icon className="h-[18px] w-[18px]" />
        </Button>
      ))}
    </div>
  );
}
