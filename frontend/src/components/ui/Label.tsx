import { type LabelHTMLAttributes, forwardRef } from "react";

interface LabelProps extends LabelHTMLAttributes<HTMLLabelElement> {}

export const Label = forwardRef<HTMLLabelElement, LabelProps>(
  ({ children, className = "", ...props }, ref) => {
    return (
      <label
        ref={ref}
        className={`block text-[13px] font-medium text-foreground mb-1.5 ${className}`}
        {...props}
      >
        {children}
      </label>
    );
  }
);

Label.displayName = "Label";
