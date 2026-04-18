#!/usr/bin/env python3
"""
Rebuild graphify graph for packages/ directory.
Merges: AST (from code files) + Semantic (from docs) + Correction data.
Outputs to graphify-out/graph.json
"""
import json
import math
import shutil
from pathlib import Path
from graphify.build import build_from_json
from graphify.cluster import cluster, score_all
from graphify.analyze import god_nodes, surprising_connections, suggest_questions
from graphify.report import generate
from graphify.export import to_json
from networkx.readwrite import json_graph

def detect_files(root_path):
    """Re-detect files in packages/"""
    from graphify.detect import detect
    result = detect(root_path)
    return result

def run_ast(code_files):
    """Extract AST from code files"""
    from graphify.extract import collect_files, extract
    files = []
    for f in code_files:
        files.extend(collect_files(Path(f)) if Path(f).is_dir() else [Path(f)])
    result = extract(files)
    Path('.graphify_ast.json').write_text(json.dumps(result, indent=2, ensure_ascii=False))
    return result

def dispatch_semantic_chunks(uncached_files, out_dir="graphify-out"):
    """Dispatch semantic extraction subagents for uncached files"""
    import subprocess
    import sys

    chunk_size = 22
    n_chunks = math.ceil(len(uncached_files) / chunk_size)

    for i in range(n_chunks):
        start = i * chunk_size
        end = min(start + chunk_size, len(uncached_files))
        chunk = uncached_files[start:end]

        # Write chunk to temp file
        chunk_file = Path(out_dir) / f".graphify_chunk_{i:02d}.json"
        chunk_file.write_text(json.dumps({"nodes": [], "edges": [], "hyperedges": [], "files": chunk}, ensure_ascii=False), encoding='utf-8')

        print(f"Chunk {i}: {len(chunk)} files -> {chunk_file}")

    return n_chunks

def merge_chunks(n_chunks, out_dir="graphify-out"):
    """Merge all chunk files into semantic JSON"""
    all_nodes = []
    all_edges = []
    all_hyperedges = []

    for i in range(n_chunks):
        chunk_file = Path(out_dir) / f".graphify_chunk_{i:02d}.json"
        if chunk_file.exists():
            data = json.loads(chunk_file.read_text(encoding='utf-8'))
            all_nodes.extend(data.get('nodes', []))
            all_edges.extend(data.get('edges', []))
            all_hyperedges.extend(data.get('hyperedges', []))

    # Deduplicate
    seen = set()
    deduped = []
    for n in all_nodes:
        if n['id'] not in seen:
            seen.add(n['id'])
            deduped.append(n)

    merged = {
        'nodes': deduped,
        'edges': all_edges,
        'hyperedges': all_hyperedges,
        'input_tokens': 0,
        'output_tokens': 0,
    }
    Path('.graphify_semantic.json').write_text(json.dumps(merged, indent=2, ensure_ascii=False), encoding='utf-8')
    return merged

def merge_all(ast_data, sem_data, correction_path=None):
    """Merge AST + semantic + corrections"""
    # AST first
    seen = {n['id'] for n in ast_data['nodes']}
    merged_nodes = list(ast_data['nodes'])
    for n in sem_data['nodes']:
        if n['id'] not in seen:
            merged_nodes.append(n)
            seen.add(n['id'])

    # Add correction nodes
    if correction_path and Path(correction_path).exists():
        corr = json.loads(Path(correction_path).read_text(encoding='utf-8'))
        for n in corr.get('nodes', []):
            if n['id'] not in seen:
                merged_nodes.append(n)
                seen.add(n['id'])

    merged_edges = ast_data['edges'] + sem_data['edges']

    if correction_path and Path(correction_path).exists():
        corr = json.loads(Path(correction_path).read_text(encoding='utf-8'))
        merged_edges.extend(corr.get('edges', []))

    merged_hyperedges = sem_data.get('hyperedges', [])
    if correction_path and Path(correction_path).exists():
        corr = json.loads(Path(correction_path).read_text(encoding='utf-8'))
        merged_hyperedges.extend(corr.get('hyperedges', []))

    return {
        'nodes': merged_nodes,
        'edges': merged_edges,
        'hyperedges': merged_hyperedges,
        'input_tokens': 0,
        'output_tokens': 0,
    }

def build_and_save(extraction, detection, out_dir="graphify-out"):
    """Build graph, cluster, analyze, save outputs"""
    G = build_from_json(extraction)
    communities = cluster(G)
    cohesion = score_all(G, communities)
    gods = god_nodes(G)
    surprises = surprising_connections(G, communities)

    labels = {}
    community_sizes = [(cid, len(members)) for cid, members in communities.items()]
    community_sizes.sort(key=lambda x: x[1], reverse=True)
    for i, (cid, _) in enumerate(community_sizes[:20]):
        labels[cid] = ['Session Bootstrap & Lifecycle',
                       'Archive Implementation',
                       'Central Database',
                       'External Training Contract',
                       'Cooldown & Correction Strategy',
                       'Workflow & Database Ops',
                       'Detection Funnel',
                       'Pain Configuration',
                       'Archive Runner',
                       'Capabilities Handler',
                       'Acceptance Test',
                       'Control UI & Merge Audit',
                       'Commands & Language',
                       'Evolution Logger & Nocturnal',
                       'API Gateway Auth',
                       'Adaptive Thresholds',
                       'Code Implementation Storage',
                       'Bash Risk & Edit Verification',
                       'Correction Cue Learner',
                       'Evolution Status & Readiness'][i] if i < 20 else f'Community {cid}'
    for cid in communities:
        if cid not in labels:
            labels[cid] = f'Community {cid}'

    questions = suggest_questions(G, communities, labels)
    tokens = {'input': extraction.get('input_tokens', 0), 'output': extraction.get('output_tokens', 0)}

    report = generate(G, communities, cohesion, labels, gods, surprises, detection, tokens, 'packages', suggested_questions=questions)
    (Path(out_dir) / 'GRAPH_REPORT.md').write_text(report, encoding='utf-8')
    to_json(G, communities, str(Path(out_dir) / 'graph.json'))
    to_html(G, communities, str(Path(out_dir) / 'graph.html'), community_labels=labels or None)

    analysis = {
        'communities': {str(k): v for k, v in communities.items()},
        'cohesion': {str(k): v for k, v in cohesion.items()},
        'gods': gods,
        'surprises': surprises,
    }
    Path('.graphify_analysis.json').write_text(json.dumps(analysis, indent=2))

    return G, communities, labels, gods, surprises

def to_html(G, communities, out_path, community_labels=None):
    """Generate HTML visualization"""
    try:
        from graphify.export import to_html as _to_html
        _to_html(G, communities, out_path, community_labels=community_labels)
    except Exception as e:
        print(f"HTML generation skipped: {e}")

def main():
    import sys

    root = Path('packages')
    out_dir = Path('graphify-out')
    out_dir.mkdir(exist_ok=True)

    # Step 1: Detect
    print("=== Detecting files ===")
    detection = detect_files(root)
    Path('.graphify_detect.json').write_text(json.dumps(detection, indent=2))
    all_files = [f for files in detection['files'].values() for f in files]
    print(f"Total files: {len(all_files)}")

    # Step 2: AST
    print("\n=== AST extraction ===")
    code_files = detection['files'].get('code', [])
    ast = run_ast(code_files)
    print(f"AST: {len(ast['nodes'])} nodes, {len(ast['edges'])} edges")

    # Step 3: Semantic chunks - dispatch
    docs = detection['files'].get('document', [])
    papers = detection['files'].get('paper', [])
    uncached = docs + papers
    print(f"\n=== Semantic chunks: {len(uncached)} files -> {math.ceil(len(uncached)/22)} chunks ===")

    n = dispatch_semantic_chunks(uncached, out_dir)
    print(f"Dispatched {n} chunks. Copy chunk JSON files from agents, then run merge.")

    # After agents complete, run:
    # sem = merge_chunks(n, out_dir)
    # merged = merge_all(ast, sem, 'graphify-out/.graphify_correction.json')
    # build_and_save(merged, detection, out_dir)
    print("\nAfter semantic agents complete, run the merge step manually.")
    print("Or use the full pipeline: python -c '...' (see rebuild script)'")

if __name__ == '__main__':
    main()
