"""SQLite persistence for knowledge documents and collection reviews."""
import json

from app.models.db import get_connection


def documents():
    with get_connection() as conn:
        return [dict(row) for row in conn.execute(
            "SELECT id, title, created_at FROM knowledge_documents ORDER BY id DESC LIMIT 100")]


def document_options():
    """All indexed documents for binding; the management page's 100-row cap is unrelated."""
    with get_connection() as conn:
        return [dict(row) for row in conn.execute(
            "SELECT d.id, d.title FROM knowledge_documents d "
            "WHERE EXISTS (SELECT 1 FROM knowledge_chunks c WHERE c.document_id = d.id) "
            "ORDER BY d.id DESC")]


def save_document(title, model, chunks):
    with get_connection() as conn:
        doc_id = conn.execute(
            "INSERT INTO knowledge_documents (title, model) VALUES (?, ?)", (title, model)).lastrowid
        conn.executemany("INSERT INTO knowledge_chunks VALUES (?, ?, ?)",
                         [(doc_id, text, json.dumps(vector)) for text, vector in chunks])
    return doc_id


def remove_document(doc_id):
    with get_connection() as conn:
        conn.execute("DELETE FROM knowledge_chunks WHERE document_id = ?", (doc_id,))
        conn.execute("DELETE FROM knowledge_documents WHERE id = ?", (doc_id,))


def knowledge_chunks(ids, model):
    placeholders = ",".join("?" for _ in ids)
    with get_connection() as conn:
        return conn.execute(
            f"""SELECT d.id, d.title, c.content, c.vector FROM knowledge_documents d
                JOIN knowledge_chunks c ON d.id = c.document_id
                WHERE d.model = ? AND d.id IN ({placeholders})""", (model, *ids)).fetchall()


def pending_reviews(source_id=None, limit=12):
    with get_connection() as conn:
        return [dict(row) for row in conn.execute(
            """SELECT c.id, c.title, c.summary FROM collect_items c
               LEFT JOIN risk_reviews r ON r.item_id = c.id
               WHERE (r.item_id IS NULL OR r.level = 'error')
                 AND (? IS NULL OR c.source_id = ?)
               ORDER BY (r.item_id IS NOT NULL), c.id DESC LIMIT ?""", (source_id, source_id, limit))]


def pending_review_ids(item_ids):
    placeholders = ",".join("?" for _ in item_ids)
    with get_connection() as conn:
        rows = conn.execute(
            f"""SELECT c.id FROM collect_items c LEFT JOIN risk_reviews r ON r.item_id = c.id
                WHERE c.id IN ({placeholders}) AND (r.item_id IS NULL OR r.level = 'error')""",
            tuple(item_ids)).fetchall()
    return {row["id"] for row in rows}


def pending_channel_reviews(limit=100):
    with get_connection() as conn:
        return [dict(row) for row in conn.execute(
            "SELECT c.id,c.title,c.summary FROM collect_items c "
            "JOIN qq_channel_sentiment_links q ON q.collect_item_id=c.id "
            "LEFT JOIN risk_reviews r ON r.item_id=c.id "
            "WHERE r.item_id IS NULL OR r.level='error' "
            "ORDER BY (r.item_id IS NOT NULL),c.id DESC LIMIT ?",(limit,))]


def save_review(item_id, level, reason, evidence):
    with get_connection() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO risk_reviews (item_id, level, reason, evidence) VALUES (?, ?, ?, ?)",
            (item_id, level, reason, evidence))
        conn.execute(
            """UPDATE risk_reviews SET level = ?, reason = ?, evidence = ?, reviewed_at = CURRENT_TIMESTAMP
               WHERE item_id = ? AND level = 'error'""", (level, reason, evidence, item_id))


def reviews():
    with get_connection() as conn:
        rows = [dict(row) for row in conn.execute(
            """SELECT c.id, c.title, c.url, c.source_name, r.level, r.reason, r.evidence, r.reviewed_at,
                      q.post_id AS channel_post_id
               FROM risk_reviews r JOIN collect_items c ON c.id = r.item_id
               LEFT JOIN qq_channel_sentiment_links q ON q.collect_item_id = c.id
               ORDER BY r.reviewed_at DESC, c.id DESC LIMIT 100""")]
        for row in rows:
            post_id = row.pop('channel_post_id', None)
            suffix = ' [' + post_id + ']' if post_id else ''
            if suffix and row['title'].endswith(suffix):
                row['title'] = row['title'][:-len(suffix)].rstrip()
        return rows


def search_warehouse(keyword):
    with get_connection() as conn:
        return [dict(row) for row in conn.execute(
            """SELECT title, url, source_name, ai_summary FROM warehouse_data
               WHERE status = 2 AND (instr(title, ?) > 0 OR instr(ai_summary, ?) > 0 OR instr(keyword, ?) > 0)
               ORDER BY id DESC LIMIT 8""", (keyword, keyword, keyword))]
