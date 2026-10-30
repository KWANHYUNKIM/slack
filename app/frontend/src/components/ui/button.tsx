import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default:
          'bg-slack-btn text-white shadow hover:bg-slack-btn-hover',
        destructive:
          'bg-red-600 text-white shadow-sm hover:bg-red-700',
        outline:
          'border border-slack-primary bg-transparent shadow-sm hover:bg-gray-100',
        secondary:
          'bg-gray-100 text-slack-primary shadow-sm hover:bg-gray-200',
        ghost: 'hover:bg-gray-100',
        link: 'text-slack-link underline-offset-4 hover:underline',
        toolbar:
          'rounded text-slack-secondary hover:bg-slack-hover hover:text-slack-primary',
        'menu-item':
          'w-full justify-start gap-2 rounded-none px-4 py-1.5 text-[14px] font-normal text-slack-primary hover:bg-slack-hover',
        'menu-item-danger':
          'w-full justify-start gap-2 rounded-none px-4 py-1.5 text-[14px] font-normal text-red-600 hover:bg-slack-hover',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-10 rounded-md px-8',
        icon: 'h-9 w-9',
        'icon-sm': 'h-7 w-7',
        'icon-xs': 'h-6 w-6',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = 'Button';

export { Button, buttonVariants };
