import json
from pathlib import Path

# Chunk 1: AI Agent mind map - rich extraction
chunk1 = {
  "nodes": [
    {"id": "ai_agent", "label": "AI Agent", "file_type": "image", "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "source_url": None, "captured_at": "2026-04-17", "author": None, "contributor": None},
    {"id": "planning", "label": "Planning", "file_type": "image", "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "source_url": None, "captured_at": "2026-04-17", "author": None, "contributor": None},
    {"id": "rag", "label": "Retrieval Augmented Generation (RAG)", "file_type": "image", "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "source_url": None, "captured_at": "2026-04-17", "author": None, "contributor": None},
    {"id": "vector_search", "label": "Vector Search", "file_type": "image", "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "source_url": None, "captured_at": "2026-04-17", "author": None, "contributor": None},
    {"id": "web_search", "label": "Web Search", "file_type": "image", "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "source_url": None, "captured_at": "2026-04-17", "author": None, "contributor": None},
    {"id": "knowledge_graph", "label": "Knowledge Graph", "file_type": "image", "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "source_url": None, "captured_at": "2026-04-17", "author": None, "contributor": None},
    {"id": "api", "label": "API", "file_type": "image", "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "source_url": None, "captured_at": "2026-04-17", "author": None, "contributor": None},
    {"id": "tool_use", "label": "Tool Use", "file_type": "image", "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "source_url": None, "captured_at": "2026-04-17", "author": None, "contributor": None},
    {"id": "code_interpreter", "label": "Code Interpreter", "file_type": "image", "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "source_url": None, "captured_at": "2026-04-17", "author": None, "contributor": None},
    {"id": "calculator", "label": "Calculator", "file_type": "image", "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "source_url": None, "captured_at": "2026-04-17", "author": None, "contributor": None},
    {"id": "custom_tool", "label": "Custom Tool", "file_type": "image", "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "source_url": None, "captured_at": "2026-04-17", "author": None, "contributor": None},
    {"id": "memory", "label": "Memory", "file_type": "image", "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "source_url": None, "captured_at": "2026-04-17", "author": None, "contributor": None},
    {"id": "short_term_memory", "label": "Short-Term Memory", "file_type": "image", "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "source_url": None, "captured_at": "2026-04-17", "author": None, "contributor": None},
    {"id": "long_term_memory", "label": "Long-Term Memory", "file_type": "image", "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "source_url": None, "captured_at": "2026-04-17", "author": None, "contributor": None},
    {"id": "safety", "label": "Safety", "file_type": "image", "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "source_url": None, "captured_at": "2026-04-17", "author": None, "contributor": None},
    {"id": "guardrails", "label": "Guardrails", "file_type": "image", "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "source_url": None, "captured_at": "2026-04-17", "author": None, "contributor": None},
    {"id": "human_in_the_loop", "label": "Human-in-the-loop", "file_type": "image", "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "source_url": None, "captured_at": "2026-04-17", "author": None, "contributor": None},
    {"id": "learning_adaptation", "label": "Learning & Adaptation", "file_type": "image", "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "source_url": None, "captured_at": "2026-04-17", "author": None, "contributor": None},
    {"id": "environment", "label": "Environment", "file_type": "image", "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "source_url": None, "captured_at": "2026-04-17", "author": None, "contributor": None},
    {"id": "observation", "label": "Observation", "file_type": "image", "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "source_url": None, "captured_at": "2026-04-17", "author": None, "contributor": None},
    {"id": "knowledge", "label": "Knowledge", "file_type": "image", "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "source_url": None, "captured_at": "2026-04-17", "author": None, "contributor": None},
    {"id": "reflection", "label": "Reflection", "file_type": "image", "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "source_url": None, "captured_at": "2026-04-17", "author": None, "contributor": None},
    {"id": "thought", "label": "Thought", "file_type": "image", "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "source_url": None, "captured_at": "2026-04-17", "author": None, "contributor": None},
    {"id": "action", "label": "Action", "file_type": "image", "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "source_url": None, "captured_at": "2026-04-17", "author": None, "contributor": None},
    {"id": "reward", "label": "Reward", "file_type": "image", "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "source_url": None, "captured_at": "2026-04-17", "author": None, "contributor": None},
    {"id": "learning_algorithm", "label": "Learning Algorithm", "file_type": "image", "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "source_url": None, "captured_at": "2026-04-17", "author": None, "contributor": None},
    {"id": "machine_learning", "label": "Machine Learning", "file_type": "image", "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "source_url": None, "captured_at": "2026-04-17", "author": None, "contributor": None},
    {"id": "reinforcement_learning", "label": "Reinforcement Learning", "file_type": "image", "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "source_url": None, "captured_at": "2026-04-17", "author": None, "contributor": None}
  ],
  "edges": [
    {"source": "ai_agent", "target": "planning", "relation": "contains", "confidence": "EXTRACTED", "confidence_score": 1.0, "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "weight": 1.0},
    {"source": "planning", "target": "rag", "relation": "branches_to", "confidence": "EXTRACTED", "confidence_score": 1.0, "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "weight": 1.0},
    {"source": "rag", "target": "vector_search", "relation": "contains", "confidence": "EXTRACTED", "confidence_score": 1.0, "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "weight": 1.0},
    {"source": "rag", "target": "web_search", "relation": "contains", "confidence": "EXTRACTED", "confidence_score": 1.0, "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "weight": 1.0},
    {"source": "rag", "target": "knowledge_graph", "relation": "contains", "confidence": "EXTRACTED", "confidence_score": 1.0, "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "weight": 1.0},
    {"source": "rag", "target": "api", "relation": "contains", "confidence": "EXTRACTED", "confidence_score": 1.0, "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "weight": 1.0},
    {"source": "planning", "target": "tool_use", "relation": "branches_to", "confidence": "EXTRACTED", "confidence_score": 1.0, "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "weight": 1.0},
    {"source": "tool_use", "target": "code_interpreter", "relation": "contains", "confidence": "EXTRACTED", "confidence_score": 1.0, "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "weight": 1.0},
    {"source": "tool_use", "target": "calculator", "relation": "contains", "confidence": "EXTRACTED", "confidence_score": 1.0, "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "weight": 1.0},
    {"source": "tool_use", "target": "custom_tool", "relation": "contains", "confidence": "EXTRACTED", "confidence_score": 1.0, "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "weight": 1.0},
    {"source": "planning", "target": "memory", "relation": "branches_to", "confidence": "EXTRACTED", "confidence_score": 1.0, "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "weight": 1.0},
    {"source": "memory", "target": "short_term_memory", "relation": "contains", "confidence": "EXTRACTED", "confidence_score": 1.0, "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "weight": 1.0},
    {"source": "memory", "target": "long_term_memory", "relation": "contains", "confidence": "EXTRACTED", "confidence_score": 1.0, "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "weight": 1.0},
    {"source": "planning", "target": "safety", "relation": "branches_to", "confidence": "EXTRACTED", "confidence_score": 1.0, "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "weight": 1.0},
    {"source": "safety", "target": "guardrails", "relation": "contains", "confidence": "EXTRACTED", "confidence_score": 1.0, "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "weight": 1.0},
    {"source": "safety", "target": "human_in_the_loop", "relation": "contains", "confidence": "EXTRACTED", "confidence_score": 1.0, "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "weight": 1.0},
    {"source": "ai_agent", "target": "learning_adaptation", "relation": "contains", "confidence": "EXTRACTED", "confidence_score": 1.0, "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "weight": 1.0},
    {"source": "environment", "target": "observation", "relation": "feeds_to", "confidence": "EXTRACTED", "confidence_score": 1.0, "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "weight": 1.0},
    {"source": "observation", "target": "knowledge", "relation": "feeds_to", "confidence": "EXTRACTED", "confidence_score": 1.0, "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "weight": 1.0},
    {"source": "knowledge", "target": "reflection", "relation": "feeds_to", "confidence": "EXTRACTED", "confidence_score": 1.0, "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "weight": 1.0},
    {"source": "reflection", "target": "thought", "relation": "feeds_to", "confidence": "EXTRACTED", "confidence_score": 1.0, "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "weight": 1.0},
    {"source": "thought", "target": "planning", "relation": "feeds_to", "confidence": "EXTRACTED", "confidence_score": 1.0, "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "weight": 1.0},
    {"source": "planning", "target": "action", "relation": "feeds_to", "confidence": "EXTRACTED", "confidence_score": 1.0, "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "weight": 1.0},
    {"source": "action", "target": "environment", "relation": "feeds_to", "confidence": "EXTRACTED", "confidence_score": 1.0, "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "weight": 1.0},
    {"source": "action", "target": "reward", "relation": "feeds_to", "confidence": "EXTRACTED", "confidence_score": 1.0, "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "weight": 1.0},
    {"source": "reward", "target": "learning_algorithm", "relation": "feeds_to", "confidence": "EXTRACTED", "confidence_score": 1.0, "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "weight": 1.0},
    {"source": "learning_algorithm", "target": "machine_learning", "relation": "contains", "confidence": "EXTRACTED", "confidence_score": 1.0, "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "weight": 1.0},
    {"source": "learning_algorithm", "target": "reinforcement_learning", "relation": "contains", "confidence": "EXTRACTED", "confidence_score": 1.0, "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "weight": 1.0},
    {"source": "short_term_memory", "target": "long_term_memory", "relation": "rationale_for", "confidence": "INFERRED", "confidence_score": 0.75, "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "weight": 0.8},
    {"source": "rag", "target": "knowledge_graph_search", "relation": "semantically_similar_to", "confidence": "INFERRED", "confidence_score": 0.85, "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "weight": 0.85},
    {"source": "observation", "target": "knowledge2", "relation": "conceptually_related_to", "confidence": "INFERRED", "confidence_score": 0.7, "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png", "source_location": None, "weight": 0.7}
  ],
  "hyperedges": [
    {"id": "reactive_planning_loop", "label": "Reactive Planning Loop", "nodes": ["environment", "observation", "knowledge", "reflection", "thought", "planning", "action"], "relation": "participate_in", "confidence": "EXTRACTED", "confidence_score": 1.0, "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png"},
    {"id": "rag_components", "label": "RAG Retrieval Methods", "nodes": ["vector_search", "web_search", "knowledge_graph", "api"], "relation": "participate_in", "confidence": "EXTRACTED", "confidence_score": 1.0, "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png"},
    {"id": "tool_types", "label": "Tool Use Types", "nodes": ["code_interpreter", "calculator", "custom_tool"], "relation": "participate_in", "confidence": "EXTRACTED", "confidence_score": 1.0, "source_file": "D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png"}
  ],
  "files": ["D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250625110448.png"]
}
Path("graphify-out/.graphify_chunk_01.json").write_text(json.dumps(chunk1, ensure_ascii=False), encoding="utf-8")

# Chunk 5: empty
Path("graphify-out/.graphify_chunk_05.json").write_text(json.dumps({"nodes": [], "edges": [], "hyperedges": [], "files": ["D:/llm_dir/AI/大语言模型/图片附件/Pasted image 20250716204225.png"]}, ensure_ascii=False), encoding="utf-8")

# Chunk 6: empty
Path("graphify-out/.graphify_chunk_06.json").write_text(json.dumps({"nodes": [], "edges": [], "hyperedges": [], "files": ["D:/llm_dir/AI/扩散模型/图片附件/640.gif"]}, ensure_ascii=False), encoding="utf-8")

# Chunk 7: empty
Path("graphify-out/.graphify_chunk_07.json").write_text(json.dumps({"nodes": [], "edges": [], "hyperedges": [], "files": ["D:/llm_dir/AI/扩散模型/图片附件/block.png"]}, ensure_ascii=False), encoding="utf-8")

print("Written chunks 1, 5, 6, 7")
