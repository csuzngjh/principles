import React from 'react';
import { useI18n } from '../i18n/ui';

export function Loading() {
  const { t } = useI18n();
  return (
    <div className="loading-state">
      <div className="spinner"></div>
      <span>{t('common.loading')}</span>
    </div>
  );
}

