import { describe, it, expect, afterEach } from 'vitest';
import { setLanguage, getLanguage, t } from '../src/i18n.js';

describe('internationalization utilities', () => {
  afterEach(() => {
    setLanguage('zh');
  });

  describe('setLanguage and getLanguage', () => {
    it('defaults to Chinese', () => {
      expect(getLanguage()).toBe('zh');
    });

    it('sets and gets English', () => {
      setLanguage('en');
      expect(getLanguage()).toBe('en');
    });

    it('sets and gets Chinese', () => {
      setLanguage('zh');
      expect(getLanguage()).toBe('zh');
    });
  });

  describe('t (translation function)', () => {
    it('returns Chinese translation when language is zh', () => {
      setLanguage('zh');
      expect(t('select_language')).toBe('选择语言');
      expect(t('install_mode')).toBe('选择安装模式');
      expect(t('workspace_dir')).toBe('工作区目录');
    });

    it('returns English translation when language is en', () => {
      setLanguage('en');
      expect(t('select_language')).toBe('Select language');
      expect(t('install_mode')).toBe('Select install mode');
      expect(t('workspace_dir')).toBe('Workspace directory');
    });

    it('falls back to key when translation is missing', () => {
      setLanguage('zh');
      expect(t('nonexistent_key_12345')).toBe('nonexistent_key_12345');
    });

    it('supports all critical installation messages', () => {
      setLanguage('zh');
      expect(t('install_complete')).toBe('安装完成！');
      expect(t('install_failed')).toBe('安装失败');
      expect(t('cancel_install')).toBe('安装已取消');
      expect(t('node_required')).toBe('需要 Node.js (>= 22)。请先安装 Node.js。');
      expect(t('node_version_unsupported')).toBe('当前 Node.js 版本不受支持（需要 >= 22）。');

      setLanguage('en');
      expect(t('install_complete')).toBe('Install complete!');
      expect(t('install_failed')).toBe('Install failed');
      expect(t('cancel_install')).toBe('Install cancelled');
      expect(t('node_required')).toBe('Node.js is required (>= 22). Install Node.js first.');
      expect(t('node_version_unsupported')).toBe('The installed Node.js version is unsupported (requires >= 22).');
    });

    it('supports all critical uninstallation messages', () => {
      setLanguage('zh');
      expect(t('uninstall_complete')).toBe('✅ 卸载完成！');
      expect(t('uninstall_failed')).toBe('卸载失败');
      expect(t('uninstall_cancelled')).toBe('卸载已取消');

      setLanguage('en');
      expect(t('uninstall_complete')).toBe('✅ Uninstall complete!');
      expect(t('uninstall_failed')).toBe('Uninstall failed');
      expect(t('uninstall_cancelled')).toBe('Uninstall cancelled');
    });
  });
});
