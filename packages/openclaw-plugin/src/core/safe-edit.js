/**
 * Safe Edit - 安全编辑工具
 *
 * 实现原则 P-03: 精确匹配前验证原则
 * 在执行编辑前强制验证文件状态
 */

import * as fs from 'fs';
import * as path from 'path';

const MAX_RETRIES = 3;
const RETRY_DELAY_BASE = 100; // ms

/**
 * 安全编辑函数
 * @param {string} filePath - 文件路径
 * @param {string} oldText - 要替换的旧文本
 * @param {string} newText - 新文本
 * @param {object} options - 选项
 * @returns {Promise<{success: boolean, attempt: number, error?: string}>}
 */
export async function safeEdit(filePath, oldText, newText, options = {}) {
  const { retries = MAX_RETRIES, fuzzyMatch = false } = options;
  const { workspaceDir, sessionId, eventLog } = options;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // 1. 读取当前文件内容
      if (!fs.existsSync(filePath)) {
        const error = `[P-03 Violation] File does not exist: ${filePath}`;
        if (eventLog && sessionId) {
          eventLog.recordRuleMatch(sessionId, {
            ruleId: 'p03_file_not_exist',
            layer: 'L1',
            severity: 3,
            textPreview: `Attempt to edit non-existent file: ${path.basename(filePath)}`
          });
        }
        return { success: false, attempt, error };
      }

      const currentContent = fs.readFileSync(filePath, 'utf-8');

      // 2. 验证 oldText 是否存在
      if (!currentContent.includes(oldText)) {
        const errorMsg = `oldText not found in ${filePath}`;
        
        // 记录 P-03 违规
        if (eventLog && sessionId) {
          eventLog.recordRuleMatch(sessionId, {
            ruleId: 'p03_exact_match_failed',
            layer: 'L1',
            severity: 2,
            textPreview: `Could not find exact text to replace (attempt ${attempt}/${retries})`
          });
        }

        // 尝试模糊匹配
        if (fuzzyMatch) {
          const lines = currentContent.split('\n');
          const oldLines = oldText.split('\n');
          const matchIndex = findFuzzyMatch(lines, oldLines);

          if (matchIndex !== -1) {
            // 找到模糊匹配，调整 oldText
            const fuzzyOldText = lines.slice(matchIndex, matchIndex + oldLines.length).join('\n');
            
            if (eventLog && sessionId) {
              eventLog.recordRuleMatch(sessionId, {
                ruleId: 'p03_fuzzy_match_success',
                layer: 'L2',
                severity: 0,
                textPreview: `Found fuzzy match at line ${matchIndex}, adjusting oldText`
              });
            }

            // 用模糊匹配的文本重试
            const newResult = await safeEdit(filePath, fuzzyOldText, newText, {
              ...options,
              fuzzyMatch: false,
              retries: 1
            });
            return newResult;
          }
        }

        const diagnosticInfo = `
[P-03 Violation] Failed to verify exact text match
File: ${filePath}
Attempt: ${attempt}/${retries}
oldText length: ${oldText.length} characters
Current file size: ${currentContent.length} characters

Possible reasons:
  - File has been modified by another process
  - Whitespace characters do not match (spaces, tabs, newlines)
  - Read text version differs from actual file version
`;

        if (eventLog && sessionId) {
          eventLog.addDiagnostic(sessionId, diagnosticInfo);
        }

        return { success: false, attempt, error: errorMsg };
      }

      // 3. 验证通过，执行编辑
      // 注意：这里需要调用实际的 edit 工具
      // 由于在插件内部，我们直接用 fs.writeFileSync
      const newContent = currentContent.replace(oldText, newText);
      fs.writeFileSync(filePath, newContent, 'utf-8');

      if (eventLog && sessionId) {
        eventLog.recordRuleMatch(sessionId, {
          ruleId: 'p03_edit_success',
          layer: 'L0',
          severity: 0,
          textPreview: `Successfully edited ${path.basename(filePath)} (attempt ${attempt})`
        });
      }

      return { success: true, attempt };

    } catch (error) {
      const errorMsg = error.message || String(error);
      
      // 检查是否是 "Could not find exact text" 错误
      if (errorMsg.includes('Could not find the exact text') && attempt < retries) {
        // 自动重试，重新读取文件
        if (eventLog && sessionId) {
          eventLog.recordRuleMatch(sessionId, {
            ruleId: 'p03_auto_retry',
            layer: 'L2',
            severity: 1,
            textPreview: `Auto-retry ${attempt + 1}/${retries} after ${RETRY_DELAY_BASE * attempt}ms`
          });
        }
        
        // 等待后重试
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_BASE * attempt));
        continue;
      }

      if (eventLog && sessionId) {
        eventLog.recordRuleMatch(sessionId, {
          ruleId: 'p03_edit_error',
          layer: 'L3',
          severity: 3,
          textPreview: `Edit error: ${errorMsg.substring(0, 100)}`
        });
      }

      return { success: false, attempt, error: errorMsg };
    }
  }

  // 所有重试都失败
  const finalError = `[P-03 Violation] Failed after ${retries} attempts`;
  if (eventLog && sessionId) {
    eventLog.recordRuleMatch(sessionId, {
      ruleId: 'p03_all_retries_failed',
      layer: 'L3',
      severity: 3,
      textPreview: `All ${retries} retry attempts exhausted`
    });
  }

  return { success: false, attempt: retries, error: finalError };
}

/**
 * 模糊匹配：在行级别查找相似文本
 * @param {string[]} lines - 文件行数组
 * @param {string[]} oldLines - 要匹配的文本行数组
 * @returns {number} 匹配的起始行索引，-1 表示未找到
 */
function findFuzzyMatch(lines, oldLines) {
  // 简化匹配：移除多余空白，保留基本的缩进结构
  const normalizeLine = (line) => line.replace(/\s+/g, ' ').trim();
  const normalizedLines = lines.map(normalizeLine);
  const normalizedOldLines = oldLines.map(normalizeLine);

  // 尝试找到匹配
  for (let i = 0; i <= lines.length - oldLines.length; i++) {
    let matchCount = 0;
    for (let j = 0; j < oldLines.length; j++) {
      if (normalizedLines[i + j] === normalizedOldLines[j]) {
        matchCount++;
      }
    }
    
    // 如果大部分行匹配（>80%），认为找到匹配
    if (matchCount >= oldLines.length * 0.8) {
      return i;
    }
  }

  return -1;
}

/**
 * 同步版本的安全编辑
 * 用于不适用 async/await 的场景
 */
export function safeEditSync(filePath, oldText, newText, options = {}) {
  // 同步版本，简化逻辑
  if (!fs.existsSync(filePath)) {
    throw new Error(`[P-03 Violation] File does not exist: ${filePath}`);
  }

  const currentContent = fs.readFileSync(filePath, 'utf-8');

  if (!currentContent.includes(oldText)) {
    throw new Error(`[P-03 Violation] oldText not found in ${filePath}`);
  }

  const newContent = currentContent.replace(oldText, newText);
  fs.writeFileSync(filePath, newContent, 'utf-8');

  return { success: true };
}
