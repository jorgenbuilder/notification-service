import React from 'react';

export default function LoadingButton({
  isLoading = false,
  disabled = false,
  onClick,
  type = 'button',
  className = '',
  children,
  title,
  ariaLabel,
  showLabelWhenLoading = true,
}) {
  const isDisabled = disabled || isLoading;
  return (
    <button
      type={type}
      className={`${className} ${isLoading ? 'is-loading' : ''}`.trim()}
      onClick={onClick}
      disabled={isDisabled}
      aria-disabled={isDisabled}
      aria-busy={isLoading}
      title={title}
      aria-label={ariaLabel}
    >
      {isLoading && <span className="spinner" aria-hidden="true" />}
      {(!isLoading || showLabelWhenLoading) && <span className="btn-label">{children}</span>}
    </button>
  );
}
