export function LoadingState({ message = "Loading..." }: { message?: string }) {
  return (
    <div className="state-card loading-state">
      <div className="spinner" />
      <p>{message}</p>
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="state-card error-state">
      <p className="error-message">{message}</p>
      {onRetry && (
        <button className="btn" onClick={onRetry} type="button">
          Retry
        </button>
      )}
    </div>
  );
}

export function EmptyState({ message = "No data yet" }: { message?: string }) {
  return (
    <div className="state-card empty-state">
      <p>{message}</p>
    </div>
  );
}
