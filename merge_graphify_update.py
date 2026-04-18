import json
from pathlib import Path

update = json.loads(Path('D:/Code/principles/.graphify_update.json').read_text(encoding='utf-8'))
if not update['nodes']:
    print('No update nodes found')
    exit(0)

# The code graph is in packages/graphify-out/
graph_path = Path('D:/Code/principles/packages/graphify-out/graph.json')
G_data = json.loads(graph_path.read_text(encoding='utf-8'))

# Deduplicate and merge nodes (graph.json uses 'nodes' array)
existing_ids = {n['id'] for n in G_data['nodes']}
new_nodes = [n for n in update['nodes'] if n['id'] not in existing_ids]
G_data['nodes'].extend(new_nodes)

# Merge links (not edges - graph.json uses NetworkX node-link format)
G_data['links'].extend(update['edges'])
if 'hyperedges' in G_data:
    G_data['hyperedges'].extend(update.get('hyperedges', []))
else:
    G_data['hyperedges'] = update.get('hyperedges', [])

graph_path.write_text(json.dumps(G_data, indent=2, ensure_ascii=False), encoding='utf-8')

# Remove update marker
Path('D:/Code/principles/.graphify_update.json').unlink()

print(f'Graph updated: {len(G_data["nodes"])} nodes (+{len(new_nodes)} new), {len(G_data["links"])} links')
