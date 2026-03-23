#!/usr/bin/env python3
"""Fix skill descriptions with better trigger conditions."""

import codecs
import os
import re

base = r'D:\Code\spicy_evolver_souls\skills'

updates = {
    'context-rebuild': 'Rebuild role context from stable files after a fresh session. TRIGGER CONDITIONS: (1) 会话刚启动或上下文被压缩 (2) 需要恢复角色记忆 (3) cron 隔离后重新运行 (4) 代理说"我不知道我是谁"或"我忘了"。Use when agent needs to recover its identity, current tasks, and team context.',
    
    'feature-development': 'Execute feature development tasks based on PM proposals. TRIGGER CONDITIONS: (1) 收到 feature task (2) 需要实现新功能 (3) 用户说"实现这个功能"、"开发这个feature" (4) 从 WORK_QUEUE.md 取出 feature task。Includes implementation, tests, and documentation.',
    
    'issue-triage': 'Produce an Issue Draft from logs, pain, runtime evidence. TRIGGER CONDITIONS: (1) 发现异常需要记录 (2) resource-scout 发现新错误 (3) 用户说"记录这个问题"、"创建 Issue" (4) pain signal 需要转化为 Issue。',
    
    'manager-dispatch': 'Route incoming signals to correct team members. TRIGGER CONDITIONS: (1) 收到新的 issue/proposal/verification 信号 (2) 需要决定谁来处理 (3) main 需要派发任务给 pm/repair/verification (4) 用户说"让xx去处理"。',
    
    'proposal-drafting': 'Convert product pain or design ambiguity into a Proposal Draft. TRIGGER CONDITIONS: (1) pm 需要写提案 (2) 发现产品设计问题 (3) 用户说"写个提案"、"设计这个功能" (4) CURRENT_FOCUS.md 有待决策事项。',
    
    'repair-execution': 'Execute a bounded Repair Task and report results. TRIGGER CONDITIONS: (1) 收到 Repair Task (2) RT 文件存在 (3) 用户说"修复这个问题" (4) issue-triage 产生了 Repair Task。',
    
    'team-standup': 'Run team daily sync for Principles internal team. TRIGGER CONDITIONS: (1) 每日站会时间 (2) main 需要同步团队状态 (3) 用户说"开站会"、"同步一下" (4) 需要更新 WORK_QUEUE.md 和 CURRENT_FOCUS.md。',
    
    'verification-gate': 'Validate a claimed fix and produce release recommendation. TRIGGER CONDITIONS: (1) repair 完成修复 (2) 需要验证 bug 是否解决 (3) 用户说"验证一下"、"测试通过了吗" (4) 准备合并 PR 前。',
    
    'weekly-governance-review': 'Run weekly governance review for Principles team. TRIGGER CONDITIONS: (1) 每周治理审查 (2) 需要刷新规划文档 (3) 用户说"周会"、"周回顾" (4) 需要更新 OKR/roadmap。',
    
    'value-proposition': 'Design a detailed value proposition using 6-part JTBD template. TRIGGER CONDITIONS: (1) 用户说"价值主张"、"value prop" (2) 需要分析客户价值 (3) 用户说"为什么客户选我们" (4) 产品定位讨论。',
    
    'video-translation': 'Translate and dub videos from one language to another. TRIGGER CONDITIONS: (1) 用户说"翻译视频"、"配音" (2) 需要给视频换语言 (3) 用户说"把这个视频转成英语" (4) 有视频文件需要处理。',
}

def main():
    for skill, new_desc in updates.items():
        skill_md = os.path.join(base, skill, 'SKILL.md')
        if not os.path.exists(skill_md):
            print(f'Not found: {skill}')
            continue
        
        with codecs.open(skill_md, 'r', 'utf-8') as f:
            content = f.read()
        
        lines = content.split('\n')
        new_lines = []
        in_desc = False
        desc_done = False
        
        for i, line in enumerate(lines):
            if line.startswith('description:'):
                in_desc = True
                # Check if multiline (ends with |)
                if '|' in line:
                    new_lines.append(f'description: {new_desc}')
                    desc_done = True
                else:
                    # Single line description
                    new_lines.append(f'description: {new_desc}')
                    desc_done = True
                continue
            
            if in_desc and not desc_done:
                # Skip old description lines until we hit next field or ---
                if line.startswith('disable-model-invocation') or line.startswith('---') or line.startswith('license') or line.startswith('metadata') or line.startswith('allowed-tools'):
                    in_desc = False
                    new_lines.append(line)
                continue
            
            new_lines.append(line)
        
        new_content = '\n'.join(new_lines)
        
        with codecs.open(skill_md, 'w', 'utf-8') as f:
            f.write(new_content)
        
        print(f'Updated: {skill}')
    
    print('\nAll descriptions updated!')

if __name__ == '__main__':
    main()
