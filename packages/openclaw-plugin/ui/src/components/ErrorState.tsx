import React from 'react';

export function ErrorState({ error }: { error: string }) {
  return <div className="panel error">{error}</div>;
}

