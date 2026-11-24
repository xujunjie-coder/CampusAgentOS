"""Durable QQ channel runs and content snapshots; IDs deduplicate within a run."""
import json

from app.models.db import get_connection, _add_column_if_missing


def init_tables(conn):
    conn.execute('''CREATE TABLE IF NOT EXISTS qq_channel_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL,
        username TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        detail TEXT NOT NULL DEFAULT '',
        result TEXT NOT NULL DEFAULT '',
        message TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')))''')
    conn.execute('''CREATE TABLE IF NOT EXISTS qq_channel_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL,
        external_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        post_id TEXT NOT NULL,
        parent_id TEXT NOT NULL DEFAULT '',
        author TEXT NOT NULL DEFAULT '',
        published_at TEXT NOT NULL DEFAULT '',
        url TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        content_text TEXT NOT NULL DEFAULT '',
        detail TEXT NOT NULL DEFAULT '',
        result TEXT NOT NULL DEFAULT '',
        review_status TEXT NOT NULL DEFAULT 'pending',
        reason TEXT NOT NULL DEFAULT '',
        reviewer TEXT NOT NULL DEFAULT '',
        reviewed_at TEXT NOT NULL DEFAULT '',
        UNIQUE(run_id, external_id))''')
    conn.execute('''CREATE INDEX IF NOT EXISTS idx_qq_items_run ON qq_channel_items (run_id)''')
    _add_column_if_missing(conn, 'qq_channel_items', "result TEXT NOT NULL DEFAULT ''")
    _add_column_if_missing(conn, 'qq_channel_items', "metadata TEXT NOT NULL DEFAULT ''")
    _add_column_if_missing(conn, 'qq_channel_items', "heat INTEGER NOT NULL DEFAULT 0")
    _add_column_if_missing(conn, 'qq_channel_items', "sort_time TEXT NOT NULL DEFAULT ''")
    conn.execute('''CREATE TABLE IF NOT EXISTS qq_channel_comment_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL,
        item_id INTEGER NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'queued',
        message TEXT NOT NULL DEFAULT '',
        result TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')))''')
    conn.execute('''CREATE TABLE IF NOT EXISTS qq_channel_sentiment_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL,
        post_id TEXT NOT NULL,
        collect_item_id INTEGER NOT NULL,
        qq_item_id INTEGER NOT NULL DEFAULT 0,
        is_excerpt INTEGER NOT NULL DEFAULT 1,
        UNIQUE(channel, post_id))''')
    _add_column_if_missing(conn,'qq_channel_sentiment_links','qq_item_id INTEGER NOT NULL DEFAULT 0')


def sync_sentiment_posts(run_id=None):
    """Idempotent post-only bridge; never fetch comments or downgrade full text."""
    imported = 0
    with get_connection() as conn:
        runs = conn.execute("SELECT id,channel,username,detail FROM qq_channel_runs "
                            "WHERE status IN ('finished','stopped') AND (? IS NULL OR id = ?) ORDER BY id",
                            (run_id,run_id)).fetchall()
        for run in runs:
            options = json.loads(run['detail'] or '{}')
            if options.get('mode') not in ('native_search','channel_hot'):
                continue
            rows = conn.execute("SELECT * FROM qq_channel_items WHERE run_id = ? AND kind = 'post' ORDER BY id",
                                (run['id'],)).fetchall()
            if not rows:
                continue
            source_name = 'QQ频道 · '+run['channel']
            conn.execute("INSERT OR IGNORE INTO sources (name,url,description,enabled) VALUES (?,?,?,0)",
                         (source_name,'https://pd.qq.com/g/'+run['channel'],
                          '频道内关键词搜索结果，由专用频道入口采集'))
            source_id = conn.execute('SELECT id FROM sources WHERE name = ?', (source_name,)).fetchone()['id']
            for row in rows:
                metadata = json.loads(row['metadata'] or '{}')
                excerpt = bool(metadata.get('is_excerpt',True))
                label = ('腾讯热门列表摘要，尚未核实全文' if options.get('mode') == 'channel_hot'
                         else '腾讯搜索摘要，尚未核实全文') if excerpt else '当前帖子正文，不含评论'
                summary = '【'+label+'】\n'+row['content']
                link = conn.execute('SELECT * FROM qq_channel_sentiment_links WHERE channel = ? AND post_id = ?',
                                    (run['channel'],row['post_id'])).fetchone()
                if link:
                    if row['id'] < link['qq_item_id'] or (not link['is_excerpt'] and excerpt):
                        continue
                    old = conn.execute('SELECT summary FROM collect_items WHERE id = ?',
                                       (link['collect_item_id'],)).fetchone()
                    if old and old['summary'] != summary:
                        conn.execute('UPDATE collect_items SET summary = ?, published_at = ? WHERE id = ?',
                                     (summary,row['published_at'],link['collect_item_id']))
                        conn.execute("UPDATE risk_reviews SET level = 'error',reason = ?,evidence = '' WHERE item_id = ?",
                                     ('帖子内容已更新，需重新分析',link['collect_item_id']))
                    conn.execute('UPDATE qq_channel_sentiment_links SET is_excerpt = ?,qq_item_id = ? WHERE id = ?',
                                 (int(excerpt),row['id'],link['id']))
                    continue
                # The platform ID keeps identical post text distinct and titles stable.
                title = row['content'].replace('\n',' ')[:75]+' ['+row['post_id']+']'
                conn.execute('INSERT OR IGNORE INTO collect_items '
                             '(source_id,source_name,keyword,title,url,summary,published_at,username) VALUES (?,?,?,?,?,?,?,?)',
                             (source_id,source_name,'、'.join(options['keywords']),title,row['url'],summary,
                              row['published_at'],run['username']))
                item_id = conn.execute('SELECT id FROM collect_items WHERE source_id = ? AND title = ?',
                                       (source_id,title)).fetchone()['id']
                conn.execute('INSERT INTO qq_channel_sentiment_links (channel,post_id,collect_item_id,is_excerpt,qq_item_id) VALUES (?,?,?,?,?)',
                             (run['channel'],row['post_id'],item_id,int(excerpt),row['id']))
                imported += 1
    return imported


def sentiment_status():
    with get_connection() as conn:
        rows = conn.execute('SELECT COALESCE(r.level,\'pending\') AS level,COUNT(*) AS n '
                            'FROM qq_channel_sentiment_links q JOIN collect_items c ON c.id=q.collect_item_id '
                            'LEFT JOIN risk_reviews r ON r.item_id=c.id GROUP BY COALESCE(r.level,\'pending\')').fetchall()
    counts = {row['level']:row['n'] for row in rows}
    return dict(counts,total=sum(counts.values()))


def create_run(options, username):
    with get_connection() as conn:
        return conn.execute(
            "INSERT INTO qq_channel_runs (channel, username, detail, result) VALUES (?, ?, ?, ?)",
            (options['channel'], username, json.dumps(options, ensure_ascii=False), '{}')).lastrowid


def _run(row):
    if row is None:
        return None
    row = dict(row)
    row['options'] = json.loads(row.pop('detail') or '{}')
    row['progress'] = json.loads(row.pop('result') or '{}')
    return row


def get_run(run_id):
    with get_connection() as conn:
        return _run(conn.execute('SELECT * FROM qq_channel_runs WHERE id = ?', (run_id,)).fetchone())


def runs():
    with get_connection() as conn:
        return [_run(row) for row in conn.execute('SELECT * FROM qq_channel_runs ORDER BY id DESC LIMIT 30')]


def update_run(run_id, status, message, progress):
    with get_connection() as conn:
        conn.execute("UPDATE qq_channel_runs SET status = CASE WHEN status = 'cancelling' AND ? = 'running' "
                     "THEN status ELSE ? END, message = ?, result = ?, "
                     "updated_at = datetime('now','localtime') WHERE id = ?",
                     (status, status, message[:500], json.dumps(progress, ensure_ascii=False), run_id))


def request_cancel(run_id):
    with get_connection() as conn:
        conn.execute("UPDATE qq_channel_runs SET status = 'cancelling' "
                     "WHERE id = ? AND status IN ('queued','running')", (run_id,))


def recover_interrupted():
    """Called once by the server entry point, never by an individual HTTP request."""
    with get_connection() as conn:
        conn.execute("UPDATE qq_channel_runs SET status = 'interrupted', "
                     "message = '服务重启，采集已中断；已保存结果仍可查看，请重新启动任务。' "
                     "WHERE status IN ('queued','running','cancelling')")
        conn.execute("UPDATE qq_channel_comment_jobs SET status = 'interrupted', "
                     "message = '服务重启，评论读取中断，可重新加载' WHERE status IN ('queued','running')")


def save_items(run_id, items):
    with get_connection() as conn:
        new = 0
        for item in items:
            cursor = conn.execute('''INSERT OR IGNORE INTO qq_channel_items
                (run_id, external_id, kind, post_id, parent_id, author, published_at,
                 url, content, content_text, detail, metadata, heat, sort_time)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
                (run_id, item['id'], item['kind'], item['post_id'], item.get('parent_id', ''),
                 item.get('author', '')[:200], item.get('time', '')[:100], item['url'],
                 item['content'], item.get('context', ''), json.dumps(item['matched'], ensure_ascii=False),
                 json.dumps(item.get('metadata',{}),ensure_ascii=False), item.get('heat',0), item.get('sort_time','')))
            new += max(0,cursor.rowcount)
            if item['kind'] == 'post':
                conn.execute('UPDATE qq_channel_items SET detail=?,heat=?,sort_time=? WHERE run_id=? AND external_id=?',
                             (json.dumps(item['matched'],ensure_ascii=False),item.get('heat',0),
                              item.get('sort_time',''),run_id,item['id']))
        return new


def items(run_id, page=1, review_status='', post_id=None, posts_only=False):
    page_size = 20 if post_id is not None else 12
    where, args = 'run_id = ?', [run_id]
    if review_status:
        where += ' AND review_status = ?'
        args.append(review_status)
    if posts_only:
        where += " AND kind = 'post'"
    if post_id is not None:
        where += " AND post_id = ? AND kind <> 'post'"
        args.append(post_id)
    with get_connection() as conn:
        total = conn.execute('SELECT COUNT(*) AS n FROM qq_channel_items WHERE ' + where, args).fetchone()['n']
        page = max(1,min(page,max(1,(total+page_size-1)//page_size)))
        rows = conn.execute('SELECT * FROM qq_channel_items WHERE ' + where +
                            ' ORDER BY heat DESC, sort_time DESC, id LIMIT ? OFFSET ?', args + [page_size,(page - 1) * page_size]).fetchall()
    out = []
    for row in rows:
        row = dict(row)
        row['matched'] = json.loads(row.pop('detail') or '[]')
        row['analysis'] = json.loads(row.pop('result') or '{}')
        row['context'] = row.pop('content_text')
        row['metadata'] = json.loads(row['metadata'] or '{}')
        out.append(row)
    return {'total': total, 'page': page, 'page_size': page_size, 'list': out}


def comment_job(item_id):
    with get_connection() as conn:
        row = conn.execute('SELECT * FROM qq_channel_comment_jobs WHERE item_id = ?', (item_id,)).fetchone()
    if row:
        row = dict(row)
        row['progress'] = json.loads(row.pop('result') or '{}')
    return row


def create_comment_job(run_id, item_id):
    with get_connection() as conn:
        conn.execute('INSERT OR IGNORE INTO qq_channel_comment_jobs (run_id,item_id) VALUES (?,?)', (run_id,item_id))
        conn.execute("UPDATE qq_channel_comment_jobs SET status='queued',message='',result='{}' WHERE item_id=?", (item_id,))


def update_comment_job(item_id, status, message, progress):
    with get_connection() as conn:
        conn.execute("UPDATE qq_channel_comment_jobs SET status=?,message=?,result=?, "
                     "updated_at=datetime('now','localtime') WHERE item_id=?",
                     (status,message[:500],json.dumps(progress,ensure_ascii=False),item_id))


def update_post(run_id, item_id, post):
    with get_connection() as conn:
        row = conn.execute('SELECT metadata FROM qq_channel_items WHERE id=? AND run_id=?', (item_id,run_id)).fetchone()
        meta = json.loads(row['metadata'] or '{}')
        meta['is_excerpt'] = False
        conn.execute('UPDATE qq_channel_items SET content=?,metadata=? WHERE id=? AND run_id=?',
                     (post['content'],json.dumps(meta,ensure_ascii=False),item_id,run_id))


def get_item(run_id, item_id):
    with get_connection() as conn:
        row = conn.execute('SELECT * FROM qq_channel_items WHERE run_id = ? AND id = ?',
                           (run_id, item_id)).fetchone()
    return dict(row) if row else None


def save_analysis(run_id, item_id, result):
    with get_connection() as conn:
        conn.execute('UPDATE qq_channel_items SET result = ? WHERE run_id = ? AND id = ?',
                     (json.dumps(result, ensure_ascii=False), run_id, item_id))


def review_item(run_id, item_id, status, reason, username):
    with get_connection() as conn:
        cur = conn.execute("UPDATE qq_channel_items SET review_status = ?, reason = ?, reviewer = ?, "
                           "reviewed_at = datetime('now','localtime') WHERE id = ? AND run_id = ?",
                           (status, reason, username, item_id, run_id))
        return cur.rowcount > 0
