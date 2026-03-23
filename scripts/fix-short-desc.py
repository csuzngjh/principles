#!/usr/bin/env python3
"""Fix short skill descriptions."""

import codecs
import os

base = r'D:\Code\spicy_evolver_souls\skills'

updates = {
    'pr-review-and-merge': 'PR 合并前的完整审查工作流。TRIGGER CONDITIONS: (1) 需要合并 PR (2) 代码审查请求 (3) 用户说"审查这个PR"、"合并前检查" (4) CI 失败需要排查。包含需求验证、交叉评审、本地测试、冲突解决。',
    
    'agent-handoff': 'Send bounded inter-agent requests and require standard artifact-shaped replies. TRIGGER CONDITIONS: (1) 需要给其他角色发送结构化请求 (2) 需要明确返回格式 (3) 跨角色协作 (4) 用户说"让xx做个xx"。Use when one role needs something from another role.',
    
    'team-retrospective': '团队复盘技能，将经验固化到技能系统、记忆系统、追踪系统。TRIGGER CONDITIONS: (1) Bug 修复完成 (2) 重大任务完成 (3) 识别出系统性问题 (4) 用户说"复盘一下"、"总结经验" (5) HEARTBEAT 检测到待执行复盘。6 步闭环：收集事实 -> 分类经验 -> 提取 Actions -> 执行立即类 -> 注册异步追踪 -> 跨智能体通知。',
    
    'agent-autonomy-rhythms': '让每个团队成员自己设定工作节奏，不再依赖 main 指挥。TRIGGER CONDITIONS: (1) 需要设定定时任务 (2) 建立自主工作节奏 (3) 配置 agent cron (4) 用户说"自动化这个"、"定时执行"。包含各角色的 cron job 配置模板、状态记录规范和自我检查逻辑。',
}

for skill, new_desc in updates.items():
    skill_md = os.path.join(base, skill, 'SKILL.md')
    with codecs.open(skill_md, 'r', 'utf-8') as f:
        content = f.read()
    
    lines = content.split('\n')
    new_lines = []
    in_desc = False
    
    for line in lines:
        if line.startswith('description:'):
            if '|' in line:
                in_desc = True
                new_lines.append(f'description: {new_desc}')
            else:
                new_lines.append(f'description: {new_desc}')
            continue
        
        if in_desc:
            if line and not line[0].isspace() and not line.startswith(' '):
                in_desc = False
                new_lines.append(line)
            continue
        
        new_lines.append(line)
    
    new_content = '\n'.join(new_lines)
    
    with codecs.open(skill_md, 'w', 'utf-8') as f:
        f.write(new_content)
    
    print(f'Updated: {skill}')

print('\nDone!')
