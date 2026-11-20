"""
db.py —— 数据库访问层 / 连接层抽象（任务14：SQLite / MySQL 双库）

对外只暴露三件事：
- 1 连接工厂 get_connection()：按 DB_DRIVER（sqlite|mysql）返回统一 Connection 包装；
- 2 方言能力函数：insert_or_ignore / now_sql / table_columns / last_insert_id / create_index_if_missing；
- 3 应用启动建表 init_db()：DDL 继续用 SQLite 语法书写，MySQL 下由方言层自动翻译
     （AUTOINCREMENT→AUTO_INCREMENT、TEXT DEFAULT→VARCHAR、IF NOT EXISTS 索引→先查后建等）。

设计要点：
- 上层 Repository 继续写 `?` 占位符，包装层按方言转成 `%s`（只转换 SQL 文本里的占位符，
  不碰字符串字面量），现有参数化写法一行不用改；
- 行对象统一为 dict 子类 Row：row["col"]、dict(row)、row[0] 三种用法都支持，
  SQLite 与 MySQL 行为一致（不依赖 sqlite3.Row / DictCursor 的差异）；
- 异常归一：db.Error / db.IntegrityError / db.OperationalError，上层不再 import sqlite3/pymysql；
- 每次取连接、用完即弃（不跨协程共享）；with 块正常退出提交、异常回滚，与 sqlite3 语义一致。
"""
import os
import re
import sqlite3
from decimal import Decimal
from typing import Any, Iterable, List, Optional, Sequence, Tuple

import app.config as config

# ---------------- 方言与连接参数（模块级，便于测试切换数据库） ----------------
DB_DRIVER = config.DB_DRIVER
DB_PATH = config.DB_PATH
DB_HOST = config.DB_HOST
DB_PORT = config.DB_PORT
DB_USER = config.DB_USER
DB_PASSWORD = config.DB_PASSWORD
DB_NAME = config.DB_NAME
DB_CHARSET = config.DB_CHARSET


def reload_settings() -> None:
    """把 app.config 的最新配置同步到本模块（测试在 SQLite/MySQL 间切换时调用）"""
    global DB_DRIVER, DB_PATH, DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME, DB_CHARSET
    config.reload(strict=True)
    DB_DRIVER = config.DB_DRIVER
    DB_PATH = config.DB_PATH
    DB_HOST = config.DB_HOST
    DB_PORT = config.DB_PORT
    DB_USER = config.DB_USER
    DB_PASSWORD = config.DB_PASSWORD
    DB_NAME = config.DB_NAME
    DB_CHARSET = config.DB_CHARSET


try:  # pymysql 是可选依赖：只有 DB_DRIVER=mysql 时才必需（缺失时 config 启动期已报错）
    import pymysql
    import pymysql.converters
    from pymysql.constants import FIELD_TYPE
except ImportError:  # pragma: no cover - 默认 SQLite 环境不会走到
    pymysql = None
    FIELD_TYPE = None


# ---------------- 统一异常 ----------------
class Error(Exception):
    """所有数据库错误的基类（上层只捕获这个家族，不再区分驱动）"""


class IntegrityError(Error):
    """唯一约束/主键冲突（原 sqlite3.IntegrityError）"""


class OperationalError(Error):
    """连接失败、库/表不存在等运行期错误（原 sqlite3.OperationalError）"""


# ---------------- 统一行对象 ----------------
class Row(dict):
    """dict 子类：支持 row["col"] / dict(row) / row[0] / 迭代出列名

    MySQL 的 SUM()/AVG() 返回 Decimal，直接 json.dumps 会 500，这里统一转成 int/float，
    保证两种库交给上层的数据类型一致（都是 JSON 可序列化类型）。
    """

    __slots__ = ("_values",)

    def __init__(self, columns: Sequence[str], values: Sequence[Any]):
        normalized = [_normalize_value(v) for v in values]
        super().__init__(zip(columns, normalized))
        self._values = tuple(normalized)

    def __getitem__(self, key):
        if isinstance(key, int):
            return self._values[key]
        return super().__getitem__(key)

    def __iter__(self):
        return iter(self.keys())


def _normalize_value(value):
    """Decimal（MySQL 聚合列）→ int/float；bytes → str（避免 JSON 序列化失败）"""
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, (bytes, bytearray)):
        return value.decode("utf-8", "replace")
    return value


# ---------------- 占位符转换 ----------------
# 只匹配字符串字面量之外的 ?：单引号串/双引号串整体跳过
_PLACEHOLDER_RE = re.compile(r"'(?:[^']|'')*'|\"(?:[^\"]|\\\")*\"|(\?)")


def to_placeholders(sql: str, driver: str = None) -> str:
    """把 Repository 里的 ? 占位符转成目标方言写法（SQLite 保持 ?，MySQL 用 %s）

    MySQL 走 pymysql 参数化执行，SQL 文本里的字面量 % 必须写成 %%；
    否则 'SELECT ... LIKE \'https://%.baidu.com/%\'' 会被当成格式串，
    报 "not enough arguments for format string"（init_db 种子信源时触发）。
    因此先转义 %，再生成 %s（顺序不能反，否则自己生成的占位符也被转义）。
    """
    driver = driver or DB_DRIVER
    if driver == "sqlite":
        return sql
    sql = sql.replace("%", "%%")
    return _PLACEHOLDER_RE.sub(lambda m: "%s" if m.group(1) else m.group(0), sql)


# ---------------- DDL 方言翻译（MySQL 5.7 约束见 docs/codingPrompt.md 任务14） ----------------
# 必须用 MEDIUMTEXT 的长文本列：5.7 的 TEXT 不允许 DEFAULT，长正文若用 VARCHAR(255) 会截断
LONG_TEXT_COLUMNS = {
    "content", "content_md", "content_text", "instructions", "ai_summary",
    "summary", "feature", "message", "vector", "evidence", "reason",
    "result", "detail",
}


def _split_columns(body: str) -> List[str]:
    """按顶层逗号切分列定义（括号内的 datetime('now','localtime') 不切；单引号串内的逗号不切）"""
    parts, buf, depth, in_str = [], [], 0, False
    for ch in body:
        if ch == "'":
            in_str = not in_str
        if not in_str:
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
            elif ch == "," and depth == 0:
                parts.append("".join(buf).strip())
                buf = []
                continue
        buf.append(ch)
    if buf:
        parts.append("".join(buf).strip())
    return [p for p in parts if p]


_AUTOINC_RE = re.compile(r"^INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT$", re.I)
_NOW_DEFAULT_RE = re.compile(r"^TEXT\s+NOT\s+NULL\s+DEFAULT\s+\(\s*datetime\(\s*'now'\s*,\s*'localtime'\s*\)\s*\)$", re.I)
_EMPTY_DEFAULT_RE = re.compile(r"^TEXT\s+NOT\s+NULL\s+DEFAULT\s+''$", re.I)
_LITERAL_DEFAULT_RE = re.compile(r"^TEXT\s+NOT\s+NULL\s+DEFAULT\s+'.*'$", re.I)


def _is_table_constraint(defn: str) -> bool:
    """判断一段定义是否表级约束

    难点：列名 key 与约束 KEY(...) 同形，靠「关键字后面是否直接跟列清单括号」区分；
    UNIQUE(source_id, title) 含空格与逗号，必须整体判定，不能按列名+类型拆。
    """
    tokens = defn.split(None, 1)
    head = tokens[0].upper()
    rest = tokens[1].lstrip() if len(tokens) > 1 else ""
    keyword, has_paren, _ = head.partition("(")
    if keyword in ("PRIMARY", "FOREIGN", "CONSTRAINT"):
        return True
    if keyword in ("UNIQUE", "KEY", "INDEX"):
        return bool(has_paren) or rest.startswith("(")
    return False


def _translate_column(defn: str) -> str:
    """单列定义 → MySQL 5.7 可执行写法（name + 类型/约束分别处理，避免把列名当成类型）"""
    defn = defn.strip()
    if not defn:
        return defn
    # 表级约束先整体判定：UNIQUE(source_id, title) 含空格，按列名拆分会把 title) 当成类型
    if _is_table_constraint(defn):
        return defn
    parts = defn.split(None, 1)
    if not parts:
        return defn
    name = parts[0].strip('`"')
    # MySQL 里 trigger / key 等是保留字，列名统一加反引号（SQLite 同样接受这种写法）
    quoted = "`%s`" % name
    rest = parts[1].strip() if len(parts) > 1 else ""
    if _AUTOINC_RE.match(rest):
        return "%s INT PRIMARY KEY AUTO_INCREMENT" % quoted
    if _NOW_DEFAULT_RE.match(rest):
        # DATETIME 配 CURRENT_TIMESTAMP（5.7 支持），返回值由连接层统一转字符串
        return "%s DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP" % quoted
    if name.lower() in LONG_TEXT_COLUMNS:
        # 长正文必须先判定（放在 DEFAULT '' 规则之前）：MEDIUMTEXT 在 5.7 不允许 DEFAULT
        return "%s MEDIUMTEXT NOT NULL" % quoted
    if _EMPTY_DEFAULT_RE.match(rest):
        return "%s VARCHAR(255) NOT NULL DEFAULT ''" % quoted
    if _LITERAL_DEFAULT_RE.match(rest):
        return "%s %s" % (quoted, rest.replace("TEXT", "VARCHAR(255)", 1))
    rest = re.sub(r"\bTEXT\b", "VARCHAR(255)", rest)
    rest = re.sub(r"\bINTEGER\b", "INT", rest)
    rest = re.sub(r"\bREAL\b", "DOUBLE", rest)
    return ("%s %s" % (quoted, rest)).strip()


def translate_ddl(sql: str) -> str:
    """把 SQLite 风格的 CREATE TABLE 翻译成 MySQL 5.7 可执行语句

    强制 ENGINE=InnoDB：phpstudy 的 MySQL 5.7 默认引擎是 MyISAM（无事务、唯一键上限 1000 字节），
    utf8mb4 下 VARCHAR(255) 的唯一键就有 1020 字节，必须换成 InnoDB 才能建表并支持事务。
    """
    m = re.match(r"\s*CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?(`?\w+`?)\s*\((.*)\)\s*$", sql, re.I | re.S)
    if not m:
        return sql
    prefix, table, body = m.group(1) or "", m.group(2), m.group(3)
    cols = [_translate_column(c) for c in _split_columns(body)]
    return ("CREATE TABLE %s%s (%s) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 "
            "COLLATE=utf8mb4_general_ci" % (prefix, table, ",\n".join(cols)))


# ---------------- 方言能力函数 ----------------
def insert_or_ignore(sql: str) -> str:
    """返回当前方言的「冲突即忽略」插入语句；调用方只需写普通 INSERT INTO"""
    if re.match(r"^\s*INSERT\s+OR\s+IGNORE", sql, re.I):
        sql = re.sub(r"^\s*INSERT\s+OR\s+IGNORE", "INSERT", sql, flags=re.I)
    if DB_DRIVER == "sqlite":
        return re.sub(r"^\s*INSERT\s+INTO", "INSERT OR IGNORE INTO", sql, flags=re.I)
    return re.sub(r"^\s*INSERT\s+INTO", "INSERT IGNORE INTO", sql, flags=re.I)


def now_sql() -> str:
    """当前时间的 SQL 表达式（用于 UPDATE ... SET updated_at=...）"""
    return "datetime('now', 'localtime')" if DB_DRIVER == "sqlite" else "NOW()"


def last_insert_id(cur) -> int:
    """自增主键（两种游标都提供 lastrowid，这里统一空值兜底）"""
    return int(getattr(cur, "lastrowid", 0) or 0)


def table_columns(table: str, conn=None) -> List[str]:
    """表字段名列表（SQLite 用 PRAGMA，MySQL 用 information_schema）；可复用调用方的连接加锁"""
    if conn is None:
        with get_connection() as own:
            return table_columns(table, own)
    if conn.driver == "sqlite":
        return [r["name"] for r in conn.execute("PRAGMA table_info(%s)" % table).fetchall()]
    rows = conn.execute(
        "SELECT COLUMN_NAME AS name FROM information_schema.columns "
        "WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ORDINAL_POSITION",
        (table,)).fetchall()
    return [r["name"] for r in rows]


def table_exists(table: str) -> bool:
    if DB_DRIVER == "sqlite":
        with get_connection() as conn:
            row = conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)).fetchone()
        return bool(row)
    with get_connection() as conn:
        row = conn.execute(
            "SELECT table_name AS name FROM information_schema.tables "
            "WHERE table_schema = DATABASE() AND table_name = ?", (table,)).fetchone()
    return bool(row)


def index_exists(table: str, index: str) -> bool:
    if DB_DRIVER == "sqlite":
        with get_connection() as conn:
            row = conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?", (index,)).fetchone()
        return bool(row)
    with get_connection() as conn:
        row = conn.execute(
            "SELECT index_name AS name FROM information_schema.statistics "
            "WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?",
            (table, index)).fetchone()
    return bool(row)


def create_index_if_missing(conn, table: str, index: str, columns_sql: str) -> None:
    """MySQL 全版本不支持 CREATE INDEX IF NOT EXISTS，统一先查后建；SQLite 直接 IF NOT EXISTS"""
    if DB_DRIVER == "sqlite":
        conn.execute("CREATE INDEX IF NOT EXISTS %s ON %s (%s)" % (index, table, columns_sql))
        return
    if not index_exists(table, index):
        conn.execute("CREATE INDEX %s ON %s (%s)" % (index, table, columns_sql))


# ---------------- 连接 / 游标包装 ----------------
class Cursor:
    """统一游标：结果集在 execute 时就物化成 Row 列表，连接关闭后仍可安全使用"""

    def __init__(self, raw, rows: List[Row] = None, rowcount: int = 0, lastrowid: int = 0):
        self.raw = raw
        self.rowcount = rowcount
        self.lastrowid = lastrowid
        self._rows = rows or []
        self._pos = 0

    def fetchone(self) -> Optional[Row]:
        if self._pos >= len(self._rows):
            return None
        row = self._rows[self._pos]
        self._pos += 1
        return row

    def fetchall(self) -> List[Row]:
        rows = self._rows[self._pos:]
        self._pos = len(self._rows)
        return rows

    def __iter__(self):
        while True:
            row = self.fetchone()
            if row is None:
                return
            yield row


_CREATE_INDEX_RE = re.compile(
    r"^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+(IF\s+NOT\s+EXISTS\s+)?(`?\w+`?)\s+ON\s+(`?\w+`?)\s*\(([^)]*)\)\s*$",
    re.I | re.S)


class Connection:
    """统一连接包装：execute/executemany/fetch*/commit/rollback/close/上下文管理器"""

    def __init__(self, driver: str, raw):
        self.driver = driver
        self.raw = raw
        self._changes = 0

    # ---------------- 语句预处理 ----------------
    def _prepare(self, sql: str) -> Tuple[str, bool]:
        """返回 (可执行 SQL, 是否跳过)；DDL 自动翻译，索引 IF NOT EXISTS 转「先查后建」"""
        if self.driver == "sqlite":
            return sql, False
        if re.match(r"^\s*CREATE\s+TABLE", sql, re.I):
            return to_placeholders(translate_ddl(sql)), False
        m = _CREATE_INDEX_RE.match(sql)
        if m:
            table = m.group(3).strip("`")
            index = m.group(2).strip("`")
            if index_exists(table, index):
                return "", True
            return "CREATE INDEX %s ON %s (%s)" % (index, table, m.group(4)), False
        if re.match(r"^\s*ALTER\s+TABLE", sql, re.I):
            # ALTER TABLE <t> ADD COLUMN <列定义> 也要走列级翻译（TEXT DEFAULT → VARCHAR 等）
            m_alter = re.match(r"^\s*ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(.+)$", sql, re.I | re.S)
            if m_alter:
                return to_placeholders("ALTER TABLE %s ADD COLUMN %s" % (
                    m_alter.group(1), _translate_column(m_alter.group(2)))), False
            return to_placeholders(sql), False
        s = re.sub(r"INSERT\s+OR\s+REPLACE", "REPLACE", sql, flags=re.I)
        s = re.sub(r"INSERT\s+OR\s+IGNORE", "INSERT IGNORE", s, flags=re.I)
        s = re.sub(r"datetime\('now'\s*,\s*'localtime'\)", "CURRENT_TIMESTAMP", s, flags=re.I)
        return to_placeholders(s), False

    # ---------------- 执行 ----------------
    def execute(self, sql: str, params: Iterable = ()) -> Cursor:
        s, skip = self._prepare(sql)
        if skip:
            return Cursor(None)
        try:
            cur = self.raw.cursor()
            cur.execute(s, tuple(params or ()))
            return self._wrap(cur)
        except Exception as exc:  # 归一成 db.* 异常
            raise self._translate_error(exc)

    def executemany(self, sql: str, seq) -> Cursor:
        s, skip = self._prepare(sql)
        if skip:
            return Cursor(None)
        rows = list(seq or [])
        if not rows:
            return Cursor(None)
        try:
            cur = self.raw.cursor()
            cur.executemany(s, [tuple(r or ()) for r in rows])
            return self._wrap(cur)
        except Exception as exc:
            raise self._translate_error(exc)

    def _wrap(self, cur) -> Cursor:
        rowcount = int(getattr(cur, "rowcount", 0) or 0)
        lastrowid = int(getattr(cur, "lastrowid", 0) or 0)
        self._changes += max(rowcount, 0)
        rows: List[Row] = []
        if cur.description:
            cols = [d[0] for d in cur.description]
            rows = [Row(cols, values) for values in cur.fetchall()]
        return Cursor(cur, rows, rowcount, lastrowid)

    def _translate_error(self, exc: Exception) -> Error:
        if self.driver == "sqlite":
            if isinstance(exc, sqlite3.IntegrityError):
                return IntegrityError(str(exc))
            if isinstance(exc, sqlite3.Error):
                return OperationalError(str(exc))
        elif pymysql is not None:
            if isinstance(exc, pymysql.err.IntegrityError):
                return IntegrityError(str(exc))
            if isinstance(exc, pymysql.err.MySQLError):
                return OperationalError("MySQL 执行失败：%s" % (exc,))
        if isinstance(exc, Error):
            return exc
        return OperationalError(str(exc))

    # ---------------- 常规能力 ----------------
    @property
    def total_changes(self) -> int:
        """累计变更行数（SQLite 语义移植到 MySQL，供批量插入统计新增条数）"""
        if self.driver == "sqlite":
            return int(self.raw.total_changes)
        return self._changes

    def commit(self) -> None:
        self.raw.commit()

    def rollback(self) -> None:
        self.raw.rollback()

    def close(self) -> None:
        try:
            self.raw.close()
        except Exception:
            pass

    def __enter__(self) -> "Connection":
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        # 与 sqlite3 一致：正常提交、异常回滚；不主动 close（交由 GC / 显式 close）
        if exc_type is None:
            self.commit()
        else:
            self.rollback()
        return False


# ---------------- MySQL 连接细节 ----------------
_MYSQL_DB_READY = False
_MYSQL_NAME_RE = re.compile(r"^[A-Za-z0-9_$]+$")


def _mysql_conv() -> dict:
    """DATETIME/TIMESTAMP/DATE 统一转字符串，避免 pymysql 返回 datetime 对象导致 JSON 序列化失败"""
    conv = pymysql.converters.conversions.copy()

    def _as_text(value):
        return value.decode("utf-8") if isinstance(value, (bytes, bytearray)) else str(value)

    for field_type in (FIELD_TYPE.DATETIME, FIELD_TYPE.TIMESTAMP, FIELD_TYPE.DATE):
        conv[field_type] = _as_text
    return conv


def _mysql_connect(with_database: bool = True):
    kwargs = dict(host=DB_HOST, port=int(DB_PORT), user=DB_USER, password=DB_PASSWORD,
                  charset=DB_CHARSET or "utf8mb4", autocommit=False, conv=_mysql_conv())
    if with_database:
        kwargs["database"] = DB_NAME
    return pymysql.connect(**kwargs)


def _ensure_mysql_database() -> None:
    """确保专用库存在（只创建自己的库，绝不触碰同实例上的其他库）"""
    global _MYSQL_DB_READY
    if _MYSQL_DB_READY:
        return
    if not _MYSQL_NAME_RE.match(DB_NAME or ""):
        raise OperationalError("DB_NAME 只允许字母、数字、下划线与 $，当前为 %r" % (DB_NAME,))
    try:
        raw = _mysql_connect(with_database=False)
    except pymysql.err.MySQLError as exc:
        raise OperationalError(
            "MySQL 连接失败（%s:%s）：%s；请确认 MySQL 已启动，并核对 .env 里的 "
            "DB_HOST/DB_PORT/DB_USER/DB_PASSWORD" % (DB_HOST, DB_PORT, exc))
    try:
        with raw.cursor() as cur:
            cur.execute("CREATE DATABASE IF NOT EXISTS `%s` DEFAULT CHARSET utf8mb4 "
                        "COLLATE utf8mb4_general_ci" % DB_NAME)
        raw.commit()
    except pymysql.err.MySQLError as exc:
        raise OperationalError("创建数据库 %s 失败：%s（请检查该账号是否有 CREATE 权限）" % (DB_NAME, exc))
    finally:
        raw.close()
    _MYSQL_DB_READY = True


def get_connection() -> Connection:
    """连接工厂：每次返回独立连接（不跨协程复用），调用方用 with 管理事务"""
    if DB_DRIVER == "mysql":
        if pymysql is None:
            raise OperationalError(
                "DB_DRIVER=mysql 但未安装 pymysql：请执行 python -m pip install pymysql")
        _ensure_mysql_database()
        try:
            return Connection("mysql", _mysql_connect())
        except pymysql.err.MySQLError as exc:
            raise OperationalError("MySQL 连接失败（%s:%s/%s）：%s" % (DB_HOST, DB_PORT, DB_NAME, exc))
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    raw = sqlite3.connect(DB_PATH, timeout=15)
    return Connection("sqlite", raw)

def _add_column_if_missing(conn, table: str, column_def: str) -> None:
    """幂等补列：存量库老表没有该列时，用 ALTER TABLE 补上；已存在则跳过（双库通用）"""
    column_name = column_def.split()[0]
    if column_name not in table_columns(table, conn):
        conn.execute("ALTER TABLE %s ADD COLUMN %s" % (table, column_def))

def _repair_messages_unique_username(conn) -> None:
    """修复历史遗留缺陷：早期库误将 messages.username 建成 UNIQUE（甚至只有一个 sqlite_autoindex），
    导致同一用户只能写入第一条消息、之后每次发消息都在落库处抛 IntegrityError。
    检测到 username 上存在唯一索引时，重建 messages 表去掉 UNIQUE，并恢复普通索引。幂等。

    仅 SQLite 需要：MySQL 建库即按正确 DDL 创建，不存在该类历史库。"""
    if DB_DRIVER != "sqlite":
        return
    idxs = conn.execute("PRAGMA index_list(messages)").fetchall()
    has_unique_username = False
    for idx in idxs:
        idx_name, is_unique = idx[1], idx[2]
        if is_unique:
            cols = [r[2] for r in conn.execute(f"PRAGMA index_info('{idx_name}')").fetchall()]
            if cols == ["username"]:
                has_unique_username = True
    if not has_unique_username:
        return
    # SQLite 不支持直接删列约束，只能重建表：重命名旧表→建新表→回灌数据→删旧表→重建普通索引
    conn.execute("ALTER TABLE messages RENAME TO messages_old")
    conn.execute('''CREATE TABLE messages
        (id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')))''')
    conn.execute("INSERT INTO messages (id, username, role, content, created_at) SELECT id, username, role, content, created_at FROM messages_old")
    conn.execute("DROP TABLE messages_old")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_username ON messages (username)")

def _seed_roles(conn: sqlite3.Connection) -> None:
    """预置内置角色：系统管理员(admin)与普通用户(user)。INSERT OR IGNORE 依 code 唯一，幂等。"""
    conn.execute(
        "INSERT OR IGNORE INTO roles (code, name, description, home, builtin) VALUES (?, ?, ?, ?, ?)",
        ("admin", "系统管理员", "后台管理权限（http://host:port/admin）", "/admin", 1))
    conn.execute(
        "INSERT OR IGNORE INTO roles (code, name, description, home, builtin) VALUES (?, ?, ?, ?, ?)",
        ("user", "普通用户", "前台使用权限（http://host:port/）", "/", 1))

def _seed_menus(conn: sqlite3.Connection) -> None:
    """首次建库时按任务3的导航树预置菜单；已有数据则不动，交给「菜单管理」维护。幂等。"""
    if conn.execute("SELECT COUNT(*) AS c FROM menus").fetchone()["c"] > 0:
        return
    conn.execute("INSERT INTO menus (parent_id, name, icon, url, description, sort, enabled) VALUES (0, '工作台', 'fas fa-tachometer-alt', '/admin', '后台首页与数据概览', 1, 1)")
    sys_id = conn.execute("INSERT INTO menus (parent_id, name, icon, url, description, sort, enabled) VALUES (0, '系统管理', 'fas fa-cogs', '', '系统配置类功能分组', 2, 1)").lastrowid
    conn.execute("INSERT INTO menus (parent_id, name, icon, url, description, sort, enabled) VALUES (?, '用户管理', 'fas fa-users', '/admin/users', '账号增删改查与分页', 1, 1)", (sys_id,))
    conn.execute("INSERT INTO menus (parent_id, name, icon, url, description, sort, enabled) VALUES (?, '角色管理', 'fas fa-user-shield', '/admin/roles', '角色与后台权限维护', 2, 1)", (sys_id,))
    conn.execute("INSERT INTO menus (parent_id, name, icon, url, description, sort, enabled) VALUES (?, '菜单管理', 'fas fa-bars', '/admin/menus', '导航菜单维护', 3, 1)", (sys_id,))

def _seed_source_menu(conn: sqlite3.Connection) -> None:
    """任务5：幂等预置「数据采集 / 信源管理」菜单。存量库 menus 已有数据，_seed_menus 的全量种子
    不会触发，这里单独按 url 存在性补种；「数据采集」分组为后续采集管理/数据仓库预留。"""
    if conn.execute("SELECT COUNT(*) AS c FROM menus WHERE url = '/admin/sources'").fetchone()["c"] > 0:
        return
    row = conn.execute("SELECT id FROM menus WHERE parent_id = 0 AND name = '数据采集'").fetchone()
    if row:
        group_id = row["id"]
    else:
        group_id = conn.execute(
            "INSERT INTO menus (parent_id, name, icon, url, description, sort, enabled) VALUES (0, '数据采集', 'fas fa-database', '', '信源/采集/数仓等数据链路功能分组', 3, 1)").lastrowid
    conn.execute(
        "INSERT INTO menus (parent_id, name, icon, url, description, sort, enabled) VALUES (?, '信源管理', 'fas fa-rss', '/admin/sources', '采集源 URL 与请求规则维护', 1, 1)",
        (group_id,))

def _seed_collect_menu(conn: sqlite3.Connection) -> None:
    """任务6：幂等预置「数据采集 / 采集管理」菜单（独立采集主页 /collect，不走 layui 后台框架）。
    与 _seed_source_menu 同样按 url 存在性补种，存量库不触发全量种子。"""
    if conn.execute("SELECT COUNT(*) AS c FROM menus WHERE url = '/collect'").fetchone()["c"] > 0:
        return
    row = conn.execute("SELECT id FROM menus WHERE parent_id = 0 AND name = '数据采集'").fetchone()
    if row:
        group_id = row["id"]
    else:
        group_id = conn.execute(
            "INSERT INTO menus (parent_id, name, icon, url, description, sort, enabled) VALUES (0, '数据采集', 'fas fa-database', '', '信源/采集/数仓等数据链路功能分组', 3, 1)").lastrowid
    conn.execute(
        "INSERT INTO menus (parent_id, name, icon, url, description, sort, enabled) VALUES (?, '采集管理', 'fas fa-satellite-dish', '/collect', '关键词驱动的多信源批量采集主页', 2, 1)",
        (group_id,))

def _seed_warehouse_menu(conn: sqlite3.Connection) -> None:
    """任务7：幂等预置「数据采集 / 数据仓库」菜单（layui 后台页 /admin/warehouse）。
    与 _seed_source_menu 同样按 url 存在性补种，存量库不触发全量种子。"""
    if conn.execute("SELECT COUNT(*) AS c FROM menus WHERE url = '/admin/warehouse'").fetchone()["c"] > 0:
        return
    row = conn.execute("SELECT id FROM menus WHERE parent_id = 0 AND name = '数据采集'").fetchone()
    if row:
        group_id = row["id"]
    else:
        group_id = conn.execute(
            "INSERT INTO menus (parent_id, name, icon, url, description, sort, enabled) VALUES (0, '数据采集', 'fas fa-database', '', '信源/采集/数仓等数据链路功能分组', 3, 1)").lastrowid
    conn.execute(
        "INSERT INTO menus (parent_id, name, icon, url, description, sort, enabled) VALUES (?, '数据仓库', 'fas fa-warehouse', '/admin/warehouse', '深采正文存储仓库，支持增删改查分页与批量深度采集', 3, 1)",
        (group_id,))

def _seed_console_menus(conn: sqlite3.Connection) -> None:
    """成员 C：幂等预置数智大屏/统计报表/工具链路/系统设置菜单，并归位历史顶级菜单

    规则：
    - 只按 url/name 存在性判断，重复启动不产生重复菜单；
    - 仅对「新建」或「parent_id=0 的历史遗留项」设置 parent/sort，
      已挂在分组下的菜单不再改动，避免覆盖「菜单管理」里的人工调整；
    - 顶级排序保持：工作台 0 / 系统管理 1 / 数据看板 2 / 数据采集 3 / 模型服务 4 /
      智能体服务 5 / 系统运维 6。
    """
    def ensure_group(name, icon, description, sort):
        row = conn.execute(
            "SELECT id FROM menus WHERE parent_id = 0 AND name = ? ORDER BY id LIMIT 1",
            (name,)).fetchone()
        if row:
            return row["id"]
        return conn.execute(
            "INSERT INTO menus (parent_id, name, icon, url, description, sort, enabled) "
            "VALUES (0, ?, ?, '', ?, ?, 1)", (name, icon, description, sort)).lastrowid

    def ensure_child(group_id, name, icon, url, description, sort):
        row = conn.execute("SELECT id, parent_id FROM menus WHERE url = ? ORDER BY id LIMIT 1",
                           (url,)).fetchone()
        if row:
            if row["parent_id"] == 0:
                conn.execute("UPDATE menus SET parent_id = ?, sort = ? WHERE id = ?",
                             (group_id, sort, row["id"]))
            return row["id"]
        return conn.execute(
            "INSERT INTO menus (parent_id, name, icon, url, description, sort, enabled) "
            "VALUES (?, ?, ?, ?, ?, ?, 1)",
            (group_id, name, icon, url, description, sort)).lastrowid

    board_id = ensure_group("数据看板", "fas fa-chart-line", "大屏与报表类数据可视化分组", 2)
    ensure_child(board_id, "数智大屏", "fas fa-tv", "/admin/dashboard",
                 "全屏实时数据大屏：地图 + 趋势 + 风险预警 + 语音问答", 1)
    ensure_child(board_id, "统计报表", "fas fa-chart-pie", "/admin/reports",
                 "分板块统计报表：趋势/信源/风险/热词，支持自选图例与 PNG 导出", 2)

    agent_id = ensure_group("智能体服务", "fas fa-user-astronaut", "数字员工与工具能力分组", 5)
    ensure_child(agent_id, "工具链路", "fas fa-link", "/admin/tools",
                 "工具注册表与数字员工绑定矩阵（只读查看）", 2)

    sys_id = ensure_group("系统管理", "fas fa-cogs", "系统配置类功能分组", 1)
    ensure_child(sys_id, "系统设置", "fas fa-sliders-h", "/admin/settings",
                 "系统名称与图标、数据库切换、语音/人脸模型与安全参数", 3)

    # 历史遗留：早期种子把知识仓库/智能舆情直接挂在顶级且 sort=0，这里归位到对应分组
    collect_id = ensure_group("数据采集", "fas fa-database", "信源/采集/数仓等数据链路功能分组", 3)
    ensure_child(collect_id, "知识仓库", "fas fa-book", "/admin/knowledge",
                 "RAG 文档入库与检索", 4)
    ensure_child(agent_id, "智能舆情", "fas fa-shield-alt", "/admin/sentiment",
                 "风险预警与人工复核", 3)


def _seed_employee_menu(conn: sqlite3.Connection) -> None:
    """任务9：幂等预置「智能体服务 / 数字员工」菜单（layui 后台页 /admin/employees）。
    与其他补种同样按 url 存在性处理，存量库不触发全量种子。"""
    if conn.execute("SELECT COUNT(*) AS c FROM menus WHERE url = '/admin/employees'").fetchone()["c"] > 0:
        return
    row = conn.execute("SELECT id FROM menus WHERE parent_id = 0 AND name = '智能体服务'").fetchone()
    if row:
        group_id = row["id"]
    else:
        group_id = conn.execute(
            "INSERT INTO menus (parent_id, name, icon, url, description, sort, enabled) VALUES (0, '智能体服务', 'fas fa-user-astronaut', '', '数字员工/工具/RAG 等智能体链路功能分组', 5, 1)").lastrowid
    conn.execute(
        "INSERT INTO menus (parent_id, name, icon, url, description, sort, enabled) VALUES (?, '数字员工', 'fas fa-users-cog', '/admin/employees', 'agentica 智能体配置统一管理（提示词/工具链路/工作空间）', 1, 1)",
        (group_id,))

def _seed_default_employee(conn: sqlite3.Connection) -> None:
    """幂等预置默认校园数字员工「华师小助手」：
    仅当 digital_employees 表为空时种子，用户删掉后不会被反复回填。"""
    if conn.execute("SELECT COUNT(*) AS c FROM digital_employees").fetchone()["c"] > 0:
        return
    instructions = "\n\n".join([
        "你是西华师范大学智慧校园平台的官方综合智能助手「华师小助手」，服务全校师生。",
        "解答校规校纪、教务选课、奖学金评定、华凤/北湖两校区通勤校车与校园生活等问题时，优先调用知识仓库与校园工具（campus_shuttle、campus_calendar、campus_gpa、campus_directory、warehouse），不编造具体政策与数据；遇到无法核实的细节提示「请以西华师范大学官网及职能部门最新公告为准」。",
        "需要查询实时资讯或天气时按需调用对应工具，并合理利用长期记忆记住用户的校区（华凤/北湖）、学院与常用偏好。",
        "输出使用条理清晰的 Markdown 格式，用中文回答。",
    ])
    conn.execute(
        "INSERT INTO digital_employees (name, description, avatar, instructions, link_files, tools, "
        "workspace_path, model_binding, rag_kb_ids, enabled, is_default, "
        "enable_long_term_memory, enable_experience_capture) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ("华师小助手", "西华师范大学智慧校园综合助手，覆盖校规政策、双校区校车日历、绩点测算与校内办事黄页。",
         "fas fa-graduation-cap", instructions, "[]",
         '["campus_shuttle", "campus_calendar", "campus_gpa", "campus_directory", "warehouse", "weather", "memory"]',
         "workspace", "", "[]", 1, 1, 1, 1))

def _seed_model_menu(conn: sqlite3.Connection) -> None:
    """任务8：幂等预置「模型服务 / 模型引擎」菜单。存量库 menus 已有数据，全量种子不会触发，
    这里按 url 存在性补种；「模型服务」分组为后续模型相关功能预留。"""
    if conn.execute("SELECT COUNT(*) AS c FROM menus WHERE url = '/admin/models'").fetchone()["c"] > 0:
        return
    row = conn.execute("SELECT id FROM menus WHERE parent_id = 0 AND name = '模型服务'").fetchone()
    if row:
        group_id = row["id"]
    else:
        group_id = conn.execute(
            "INSERT INTO menus (parent_id, name, icon, url, description, sort, enabled) VALUES (0, '模型服务', 'fas fa-microchip', '', '大模型接入与引擎管理功能分组', 4, 1)").lastrowid
    conn.execute(
        "INSERT INTO menus (parent_id, name, icon, url, description, sort, enabled) VALUES (?, '模型引擎', 'fas fa-robot', '/admin/models', '大模型接入与对话测试管理', 1, 1)",
        (group_id,))

def _seed_default_model_engine(conn: sqlite3.Connection) -> None:
    """任务8：幂等预置默认文本模型（任务给定的本地 OpenAI 范式服务）。
    仅当 model_engines 表为空时种子，用户删掉默认模型后不会被反复回填。"""
    if conn.execute("SELECT COUNT(*) AS c FROM model_engines").fetchone()["c"] > 0:
        return
    conn.execute(
        "INSERT INTO model_engines (name, api_url, api_key, model_id, type, thinking, enabled, is_default, description) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ("Smart 文本模型", "http://127.0.0.1:11435/v1",
         "ahk_7a27355237a66483832ea930796675538e6d6f2b8e4db063",
         "xmh", "text", 1, 1, 1, "任务8预置的本地 OpenAI 范式文本模型，系统默认引擎"))

def _fix_invalid_menu_icons(conn: sqlite3.Connection) -> None:
    """幂等修正菜单图标：vendor 内置的是 FontAwesome 5.15.4 free，没有 FA6 的 fa-gauge-high，
    该类名在页面里匹配不到任何 CSS 规则（::before 无 content），图标列会是一片空白，
    因此把 FA6 专有类名回退为 v5 中真实存在的等价类名（对存量库同样生效）。"""
    icon_fixes = {
        'fas fa-gauge-high': 'fas fa-tachometer-alt',
    }
    for bad_icon, good_icon in icon_fixes.items():
        conn.execute("UPDATE menus SET icon = ? WHERE icon = ?", (good_icon, bad_icon))

def _backfill_menu_descriptions(conn: sqlite3.Connection) -> None:
    """幂等回填菜单简介：早期建表时 menus 还没有 description 列，后来 _add_column_if_missing 补列
    只会给存量行填默认空串，而 _seed_menus 见到已有数据会直接 return，导致菜单管理的「简介」列全是 -。
    这里按 url（无 url 的分组按名称）把内置菜单的空简介补齐，已有内容的自定义菜单不动。"""
    defaults = {
        "/admin": "后台首页与数据概览",
        "/admin/users": "账号增删改查与分页",
        "/admin/roles": "角色与后台权限维护",
        "/admin/menus": "导航菜单维护",
        "/admin/sources": "采集源 URL 与请求规则维护",
        "/collect": "关键词驱动的多信源批量采集主页",
        "/admin/warehouse": "深采正文存储仓库，支持增删改查分页与批量深度采集",
        "/admin/models": "大模型接入与对话测试管理",
        "/admin/employees": "agentica 智能体配置统一管理（提示词/工具链路/工作空间）",
    }
    for url, description in defaults.items():
        conn.execute("UPDATE menus SET description = ? WHERE url = ? AND (description = '' OR description IS NULL)",
                     (description, url))
    conn.execute("UPDATE menus SET description = ? WHERE name = ? AND (description = '' OR description IS NULL)",
                 ("系统配置类功能分组", "系统管理"))
    conn.execute("UPDATE menus SET description = ? WHERE name = ? AND (description = '' OR description IS NULL)",
                 ("信源/采集/数仓等数据链路功能分组", "数据采集"))

def _seed_task_menu(conn: sqlite3.Connection) -> None:
    """成员 E：幂等预置「系统运维 / 定时任务」菜单（layui 后台页 /admin/tasks）。
    与其他补种同样按 url 存在性处理，存量库不触发全量种子。"""
    if conn.execute("SELECT COUNT(*) AS c FROM menus WHERE url = '/admin/tasks'").fetchone()["c"] > 0:
        return
    row = conn.execute("SELECT id FROM menus WHERE parent_id = 0 AND name = '系统运维'").fetchone()
    if row:
        group_id = row["id"]
    else:
        group_id = conn.execute(
            "INSERT INTO menus (parent_id, name, icon, url, description, sort, enabled) VALUES (0, '系统运维', 'fas fa-tools', '', '定时任务/日志清理/数据归档等运维功能分组', 6, 1)").lastrowid
    conn.execute(
        "INSERT INTO menus (parent_id, name, icon, url, description, sort, enabled) VALUES (?, '定时任务', 'fas fa-clock', '/admin/tasks', '周期任务调度、自动归档、日志清理与结果通知', 1, 1)",
        (group_id,))

def _seed_default_tasks(conn: sqlite3.Connection) -> None:
    """成员 E：幂等预置两个内置运维定时任务（日志清理 / 自动归档），按 name UNIQUE 去重。
    默认间隔：日志清理每天一次、自动归档每天一次；默认仅失败通知、渠道不通知（未配置凭据时不报错）。"""
    defaults = [
        ("每日日志清理", "log_cleanup", "清理过旧的登录审计、任务流水并回收已撤销/过期会话",
         '{"login_logs_days": 90, "task_logs_days": 30}', 86400),
        ("每日会话归档", "auto_archive", "把超过保留期的历史会话消息归档到 message_archives",
         '{"keep_days": 90}', 86400),
    ]
    for name, ttype, desc, params, interval in defaults:
        conn.execute(
            "INSERT OR IGNORE INTO scheduled_tasks (name, task_type, description, params, "
            "schedule_type, interval_seconds, cron_expr, enabled, notify_on, notify_channel, last_status) "
            "VALUES (?, ?, ?, ?, 'interval', ?, '', 1, 'fail', 'none', '')",
            (name, ttype, desc, params, interval))

def _seed_notify_menu(conn: sqlite3.Connection) -> None:
    """成员 E：幂等预置「系统运维 / 通知配置」菜单（Web 页面在线配置邮件/QQ 通知参数）。"""
    if conn.execute("SELECT COUNT(*) AS c FROM menus WHERE url = '/admin/notify'").fetchone()["c"] > 0:
        return
    row = conn.execute("SELECT id FROM menus WHERE parent_id = 0 AND name = '系统运维'").fetchone()
    if row:
        group_id = row["id"]
    else:
        group_id = conn.execute(
            "INSERT INTO menus (parent_id, name, icon, url, description, sort, enabled) VALUES (0, '系统运维', 'fas fa-tools', '', '定时任务/日志清理/数据归档等运维功能分组', 6, 1)").lastrowid
    conn.execute(
        "INSERT INTO menus (parent_id, name, icon, url, description, sort, enabled) VALUES (?, '通知配置', 'fas fa-bell', '/admin/notify', '邮件 SMTP / QQ 机器人在线配置', 2, 1)",
        (group_id,))

def _seed_archive_menu(conn: sqlite3.Connection) -> None:
    """成员 E：幂等预置「系统运维 / 会话归档」菜单（message_archives 历史会话追溯页）。"""
    if conn.execute("SELECT COUNT(*) AS c FROM menus WHERE url = '/admin/archives'").fetchone()["c"] > 0:
        return
    row = conn.execute("SELECT id FROM menus WHERE parent_id = 0 AND name = '系统运维'").fetchone()
    if row:
        group_id = row["id"]
    else:
        group_id = conn.execute(
            "INSERT INTO menus (parent_id, name, icon, url, description, sort, enabled) VALUES (0, '系统运维', 'fas fa-tools', '', '定时任务/日志清理/数据归档等运维功能分组', 6, 1)").lastrowid
    conn.execute(
        "INSERT INTO menus (parent_id, name, icon, url, description, sort, enabled) VALUES (?, '会话归档', 'fas fa-archive', '/admin/archives', '历史会话归档列表追溯，支持按用户/会话/时间筛选', 3, 1)",
        (group_id,))

def _ensure_ops_group(conn: sqlite3.Connection) -> int:
    """成员 E：获取或创建「系统运维」顶级菜单分组，返回 group_id。"""
    row = conn.execute("SELECT id FROM menus WHERE parent_id = 0 AND name = '系统运维'").fetchone()
    if row:
        return row["id"]
    return conn.execute(
        "INSERT INTO menus (parent_id, name, icon, url, description, sort, enabled) VALUES (0, '系统运维', 'fas fa-tools', '', '定时任务/日志清理/数据归档等运维功能分组', 6, 1)").lastrowid

def _seed_messages_menu(conn: sqlite3.Connection) -> None:
    """成员 E：幂等预置「系统运维 / 对话记录」菜单（messages 跨用户后台管理）。"""
    if conn.execute("SELECT COUNT(*) AS c FROM menus WHERE url = '/admin/messages'").fetchone()["c"] > 0:
        return
    group_id = _ensure_ops_group(conn)
    conn.execute(
        "INSERT INTO menus (parent_id, name, icon, url, description, sort, enabled) VALUES (?, '对话记录', 'fas fa-comments', '/admin/messages', '跨用户查看近期活跃对话，支持搜索/删除/批量操作', 4, 1)",
        (group_id,))

def _seed_sessions_menu(conn: sqlite3.Connection) -> None:
    """成员 E：幂等预置「系统运维 / 临时会话」菜单（user_sessions 登录会话列表）。"""
    if conn.execute("SELECT COUNT(*) AS c FROM menus WHERE url = '/admin/sessions'").fetchone()["c"] > 0:
        return
    group_id = _ensure_ops_group(conn)
    conn.execute(
        "INSERT INTO menus (parent_id, name, icon, url, description, sort, enabled) VALUES (?, '临时会话', 'fas fa-user-clock', '/admin/sessions', '登录会话（token）列表与强制下线，支持按用户/IP/状态筛选', 5, 1)",
        (group_id,))

def _seed_music_tracks(conn) -> None:
    """成员 D（任务2 @音乐播放）：幂等预置内置示例曲库。
    音频为 tools 级脚本 tests/gen_music_wavs.py 程序化合成的短片段（static/music/），
    全离线可播；后续接真实曲库只需替换 file 字段与检索接口。"""
    if conn.execute("SELECT COUNT(*) AS c FROM music_tracks").fetchone()["c"] > 0:
        return
    tracks = [
        ("静谧晨光", "GovAgent Studio", "轻音乐", "清晨 钢琴 舒缓", "/static/music/dawn.wav", 12),
        ("星空航行", "GovAgent Studio", "电子", "夜晚 合成器 氛围", "/static/music/starry.wav", 12),
        ("仲夏糖果", "GovAgent Studio", "尤克里里", "夏天 轻快 甜美", "/static/music/summer.wav", 12),
        ("在路上", "GovAgent Studio", "摇滚", "鼓点 励志 能量", "/static/music/road.wav", 12),
        ("疗愈之雨", "GovAgent Studio", "治愈", "雨声 钢琴 放松", "/static/music/rain.wav", 12),
        ("赛博脉冲", "GovAgent Studio", "电子", "脉冲 节奏 科技", "/static/music/pulse.wav", 12),
    ]
    for title, artist, style, tags, file, duration in tracks:
        conn.execute(
            "INSERT INTO music_tracks (title, artist, style, tags, file, duration) VALUES (?, ?, ?, ?, ?, ?)",
            (title, artist, style, tags, file, duration))

def init_db():
    """
    创建本项目需要的两张表
    users：用户信息表
    id：用户ID，主键，自增
    username：用户名，唯一，unique保证不重名
    password_hash：密码哈希，保存用户密码字段，PBKDF2
    salt：密码盐，用于增加密码哈希的复杂度，每次生成随机字符串，增加密码破解难度
    role：登录角色，user=普通用户（登录后进入/），admin=管理员（登录后进入/admin）；注册链路只允许产生user
    assistant_employee_id：任务10，该用户在对话页选定的数字助理（digital_employees.id），0=跟随系统默认数字员工
    created_at：创建时间，记录用户创建时间，默认取数据库本地时间，datetime模块提供时间处理

    messages:聊天对话记录表
    id：消息ID，主键，自增
    username：用户名，关联users表的username，用于按用户隔离会话
    role：角色，user=用户，system=系统，assistant=助手，tool=工具
    content：消息内容，保存用户对话内容
    employee_id/employee_name：任务10，应答该条消息的数字员工身份（用户消息为 0/空串）
    created_at：创建时间，记录消息创建时间，默认取数据库本地时间，datetime模块提供时间处理
    """

    with get_connection() as conn:
        conn.execute('''CREATE TABLE IF NOT EXISTS users
            (id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            salt TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'user',
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')))''')
        #存量库的users老表没有role列，CREATE IF NOT EXISTS不会修改已有表结构，需幂等补列
        _add_column_if_missing(conn, 'users', "role TEXT NOT NULL DEFAULT 'user'")
        #任务10：前台用户与数字助理（数字员工）的关联偏好，0=未选择（跟随系统默认数字员工）
        _add_column_if_missing(conn, 'users', "assistant_employee_id INTEGER NOT NULL DEFAULT 0")
        #预留管理员：username为admin的账号固定为admin角色
        conn.execute("UPDATE users SET role = 'admin' WHERE username = 'admin'")

        conn.execute('''CREATE TABLE IF NOT EXISTS messages
            (id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')))''')
        #同一用户需要能保存多条消息，username不加UNIQUE，只建普通索引加速按用户查询
        conn.execute('''CREATE INDEX IF NOT EXISTS idx_messages_username ON messages (username)''')
        #任务10：幂等补列，记录每条应答由哪个数字员工产出（历史气泡按发言人身份渲染）
        _add_column_if_missing(conn, 'messages', "employee_id INTEGER NOT NULL DEFAULT 0")
        _add_column_if_missing(conn, 'messages', "employee_name TEXT NOT NULL DEFAULT ''")
        #早期错误 schema 可能已把 messages.username 建成 UNIQUE，CREATE IF NOT EXISTS 无法修复，这里幂等重建
        _repair_messages_unique_username(conn)

        #任务4：角色表与菜单表（后台管理的用户/角色/菜单三模块落库），全部 CREATE IF NOT EXISTS 可安全重执
        conn.execute('''CREATE TABLE IF NOT EXISTS roles
            (id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            home TEXT NOT NULL DEFAULT '/',
            builtin INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')))''')
        conn.execute('''CREATE TABLE IF NOT EXISTS menus
            (id INTEGER PRIMARY KEY AUTOINCREMENT,
            parent_id INTEGER NOT NULL DEFAULT 0,
            name TEXT NOT NULL,
            icon TEXT NOT NULL DEFAULT '',
            url TEXT NOT NULL DEFAULT '',
            description TEXT NOT NULL DEFAULT '',
            sort INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')))''')
        #存量库 menus 老表可能没有 description 列（简介），幂等补列
        _add_column_if_missing(conn, 'menus', "description TEXT NOT NULL DEFAULT ''")
        #角色-菜单关联表（任务4修正：不同角色不同后台权限）：role_id 对应 roles.id，menu_id 对应 menus.id
        conn.execute('''CREATE TABLE IF NOT EXISTS role_menus
            (role_id INTEGER NOT NULL,
            menu_id INTEGER NOT NULL,
            PRIMARY KEY (role_id, menu_id))''')
        _seed_roles(conn)
        _seed_menus(conn)
        #任务5：信源表（URL 规格 + Request Headers 规则，headers 存 JSON），CREATE IF NOT EXISTS 可安全重执
        conn.execute('''CREATE TABLE IF NOT EXISTS sources
            (id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            url TEXT NOT NULL,
            headers TEXT NOT NULL DEFAULT '{}',
            description TEXT NOT NULL DEFAULT '',
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')))''')
        #存量库补种信源管理菜单（首次全量种子不会覆盖已有 menus 数据）
        _seed_source_menu(conn)
        for name, url in (
            ("百度新闻", "https://www.baidu.com/s?tn=news&word={关键字}&pn={分页}"),
            ("中新网即时新闻 RSS", "https://www.chinanews.com.cn/rss/scroll-news.xml"),
            ("Google 新闻 RSS", "https://news.google.com/rss/search?q={关键字}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans"),
        ):
            if name == "百度新闻" and conn.execute(
                "SELECT 1 FROM sources WHERE url LIKE 'https://%.baidu.com/%' AND name LIKE '%百度%' AND enabled = 1"
            ).fetchone():
                continue
            conn.execute("INSERT OR IGNORE INTO sources (name, url) VALUES (?, ?)", (name, url))

        #任务6：采集数据表（采集管理抓回并解析的条目，橱窗列表数据底座），CREATE IF NOT EXISTS 可安全重执
        conn.execute('''CREATE TABLE IF NOT EXISTS collect_items
            (id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_id INTEGER NOT NULL,
            source_name TEXT NOT NULL DEFAULT '',
            keyword TEXT NOT NULL DEFAULT '',
            title TEXT NOT NULL,
            url TEXT NOT NULL DEFAULT '',
            cover TEXT NOT NULL DEFAULT '',
            summary TEXT NOT NULL DEFAULT '',
            published_at TEXT NOT NULL DEFAULT '',
            username TEXT NOT NULL DEFAULT '',
            collected_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
            UNIQUE(source_id, title))''')
        conn.execute('''CREATE INDEX IF NOT EXISTS idx_collect_items_source ON collect_items (source_id)''')
        #存量库补种采集管理菜单（独立主页 /collect）
        _seed_collect_menu(conn)
        #任务7：数据仓库表（深度采集抽取的详细正文与分析结果，UNIQUE(collect_item_id) 与原数据一一对应）
        conn.execute('''CREATE TABLE IF NOT EXISTS warehouse_data
            (id INTEGER PRIMARY KEY AUTOINCREMENT,
            collect_item_id INTEGER NOT NULL UNIQUE,
            source_id INTEGER NOT NULL DEFAULT 0,
            source_name TEXT NOT NULL DEFAULT '',
            keyword TEXT NOT NULL DEFAULT '',
            title TEXT NOT NULL DEFAULT '',
            url TEXT NOT NULL DEFAULT '',
            content_md TEXT NOT NULL DEFAULT '',
            content_text TEXT NOT NULL DEFAULT '',
            word_count INTEGER NOT NULL DEFAULT 0,
            ai_summary TEXT NOT NULL DEFAULT '',
            ai_keywords TEXT NOT NULL DEFAULT '[]',
            images TEXT NOT NULL DEFAULT '[]',
            engine TEXT NOT NULL DEFAULT '',
            llm_used INTEGER NOT NULL DEFAULT 0,
            error TEXT NOT NULL DEFAULT '',
            status INTEGER NOT NULL DEFAULT 0,
            username TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')))''')
        conn.execute('''CREATE INDEX IF NOT EXISTS idx_warehouse_data_source ON warehouse_data (source_id)''')
        #存量库补种数据仓库菜单（layui 后台页 /admin/warehouse）
        _seed_warehouse_menu(conn)
        #任务8：模型引擎表（OpenAI 范式接入配置，is_default 全系统唯一默认），CREATE IF NOT EXISTS 可安全重执
        conn.execute('''CREATE TABLE IF NOT EXISTS model_engines
            (id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            api_url TEXT NOT NULL,
            api_key TEXT NOT NULL DEFAULT '',
            model_id TEXT NOT NULL,
            type TEXT NOT NULL DEFAULT 'text',
            thinking INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 1,
            is_default INTEGER NOT NULL DEFAULT 0,
            description TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')))''')
        #存量库补种模型引擎菜单 + 预置任务给定的默认文本模型（表空时才种子）
        _seed_model_menu(conn)
        _seed_default_model_engine(conn)
        #任务8.1：模型 token 流水表（每次真实调用落一条，卡片与图表由此聚合），CREATE IF NOT EXISTS 可安全重执
        conn.execute('''CREATE TABLE IF NOT EXISTS model_token_logs
            (id INTEGER PRIMARY KEY AUTOINCREMENT,
            engine_id INTEGER NOT NULL,
            kind TEXT NOT NULL DEFAULT 'model_test',
            prompt_tokens INTEGER NOT NULL DEFAULT 0,
            completion_tokens INTEGER NOT NULL DEFAULT 0,
            total_tokens INTEGER NOT NULL DEFAULT 0,
            username TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')))''')
        conn.execute('''CREATE INDEX IF NOT EXISTS idx_token_logs_engine ON model_token_logs (engine_id)''')
        conn.execute('''CREATE INDEX IF NOT EXISTS idx_token_logs_created ON model_token_logs (created_at)''')
        #任务9：数字员工表（agentica 智能体配置入库：instructions/tools/workspace），CREATE IF NOT EXISTS 可安全重执
        conn.execute('''CREATE TABLE IF NOT EXISTS digital_employees
            (id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            description TEXT NOT NULL DEFAULT '',
            avatar TEXT NOT NULL DEFAULT 'fas fa-briefcase',
            instructions TEXT NOT NULL DEFAULT '',
            link_files TEXT NOT NULL DEFAULT '[]',
            tools TEXT NOT NULL DEFAULT '[]',
            workspace_path TEXT NOT NULL DEFAULT 'workspace',
            model_binding TEXT NOT NULL DEFAULT '',
            rag_kb_ids TEXT NOT NULL DEFAULT '[]',
            enabled INTEGER NOT NULL DEFAULT 1,
            is_default INTEGER NOT NULL DEFAULT 0,
            enable_long_term_memory INTEGER NOT NULL DEFAULT 1,
            enable_experience_capture INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')))''')
        #存量库补种数字员工菜单 + 预置「旅行规划师」（表空时才种子）
        _seed_employee_menu(conn)
        _seed_default_employee(conn)
        _add_column_if_missing(conn, "messages", "session_id TEXT NOT NULL DEFAULT 'default'")
        _add_column_if_missing(conn, "messages", "is_partial INTEGER NOT NULL DEFAULT 0")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(username, session_id, id)")
        conn.execute('''CREATE TABLE IF NOT EXISTS knowledge_documents
            (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, model TEXT NOT NULL,
             created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')))''')
        conn.execute('''CREATE TABLE IF NOT EXISTS knowledge_chunks
            (document_id INTEGER NOT NULL, content TEXT NOT NULL, vector TEXT NOT NULL)''')
        conn.execute("CREATE INDEX IF NOT EXISTS idx_knowledge_chunks ON knowledge_chunks(document_id)")
        conn.execute('''CREATE TABLE IF NOT EXISTS risk_reviews
            (item_id INTEGER PRIMARY KEY, level TEXT NOT NULL, reason TEXT NOT NULL,
             evidence TEXT NOT NULL, reviewed_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')))''')
        for label, path in (("知识仓库", "/admin/knowledge"), ("智能舆情", "/admin/sentiment")):
            if not conn.execute("SELECT 1 FROM menus WHERE url = ?", (path,)).fetchone():
                conn.execute("INSERT INTO menus (name, url, icon) VALUES (?, ?, 'fas fa-database')",
                             (label, path))
        #成员 C：幂等补种数智大屏/统计报表/工具链路/系统设置，并把上面两条顶级菜单归位到分组
        _seed_console_menus(conn)

        #早期预置数据用了 FA6 图标类名，本地 vendor 为 FA5，幂等回替换成有效类名
        _fix_invalid_menu_icons(conn)
        #补列之前的存量菜单没有简介，幂等回填内置菜单的说明文案
        _backfill_menu_descriptions(conn)

        # ---------------- 任务11：Token 会话 + 登录安全 ----------------
        #users 补列：最近登录时间、连续失败次数、锁定截止时间（空串表示未锁定）
        _add_column_if_missing(conn, 'users', "last_login_at TEXT NOT NULL DEFAULT ''")
        _add_column_if_missing(conn, 'users', "failed_count INTEGER NOT NULL DEFAULT 0")
        _add_column_if_missing(conn, 'users', "locked_until TEXT NOT NULL DEFAULT ''")
        #会话表：只存 token 的 SHA256 哈希，明文绝不落库（撤销=revoked 1，过期=expires_at 早于当前时间）
        conn.execute('''CREATE TABLE IF NOT EXISTS user_sessions
            (id INTEGER PRIMARY KEY AUTOINCREMENT,
            token_hash TEXT NOT NULL UNIQUE,
            username TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'user',
            client_ip TEXT NOT NULL DEFAULT '',
            user_agent TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
            last_seen_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
            expires_at TEXT NOT NULL,
            revoked INTEGER NOT NULL DEFAULT 0)''')
        conn.execute('''CREATE INDEX IF NOT EXISTS idx_sessions_username ON user_sessions (username)''')
        conn.execute('''CREATE INDEX IF NOT EXISTS idx_sessions_expires ON user_sessions (expires_at)''')
        #登录审计表：记录成功/失败/锁定/人脸登录结果，后台可查（不含密码与 token）
        conn.execute('''CREATE TABLE IF NOT EXISTS login_logs
            (id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL DEFAULT '',
            client_ip TEXT NOT NULL DEFAULT '',
            user_agent TEXT NOT NULL DEFAULT '',
            result TEXT NOT NULL DEFAULT '',
            message TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')))''')
        conn.execute('''CREATE INDEX IF NOT EXISTS idx_login_logs_username ON login_logs (username)''')
        conn.execute('''CREATE INDEX IF NOT EXISTS idx_login_logs_created ON login_logs (created_at)''')

        # ---------------- 任务12：人脸登录与人脸数据管理 ----------------
        #users 补列：是否允许该账号使用人脸登录（0=未启用，录入人脸后由用户/管理员开启）
        _add_column_if_missing(conn, 'users', "face_enabled INTEGER NOT NULL DEFAULT 0")
        #人脸特征表：feature 存加密后的特征串（绝不存原始图片，也不回传原始向量）
        conn.execute('''CREATE TABLE IF NOT EXISTS user_faces
            (id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            face_label TEXT NOT NULL DEFAULT 'default',
            feature TEXT NOT NULL,
            feature_algo TEXT NOT NULL DEFAULT '',
            quality REAL NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
            UNIQUE(username, face_label))''')
        conn.execute('''CREATE INDEX IF NOT EXISTS idx_user_faces_username ON user_faces (username)''')

        # ---------------- 成员 E：定时任务 / 任务日志 / 会话归档 ----------------
        # 周期任务配置表：调度方式（interval 间隔 / cron 表达式）、启停、通知策略、运行状态回写
        conn.execute('''CREATE TABLE IF NOT EXISTS scheduled_tasks
            (id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            task_type TEXT NOT NULL DEFAULT 'log_cleanup',
            description TEXT NOT NULL DEFAULT '',
            params TEXT NOT NULL DEFAULT '{}',
            schedule_type TEXT NOT NULL DEFAULT 'interval',
            interval_seconds INTEGER NOT NULL DEFAULT 3600,
            cron_expr TEXT NOT NULL DEFAULT '',
            enabled INTEGER NOT NULL DEFAULT 1,
            notify_on TEXT NOT NULL DEFAULT 'fail',
            notify_channel TEXT NOT NULL DEFAULT 'none',
            last_run_at TEXT NOT NULL DEFAULT '',
            next_run_at TEXT NOT NULL DEFAULT '',
            last_status TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')))''')
        # 任务执行流水表：触发方式、状态、起止时间、耗时、结果与详情
        conn.execute('''CREATE TABLE IF NOT EXISTS task_logs
            (id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER NOT NULL DEFAULT 0,
            task_name TEXT NOT NULL DEFAULT '',
            task_type TEXT NOT NULL DEFAULT '',
            trigger TEXT NOT NULL DEFAULT 'schedule',
            status TEXT NOT NULL DEFAULT 'running',
            started_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
            finished_at TEXT NOT NULL DEFAULT '',
            duration_ms INTEGER NOT NULL DEFAULT 0,
            result TEXT NOT NULL DEFAULT '',
            detail TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')))''')
        conn.execute('''CREATE INDEX IF NOT EXISTS idx_task_logs_task ON task_logs (task_id)''')
        conn.execute('''CREATE INDEX IF NOT EXISTS idx_task_logs_created ON task_logs (created_at)''')
        # 历史会话归档表：自动归档把过期 messages 迁移到此，origin_id 保留原消息 id 可追溯
        conn.execute('''CREATE TABLE IF NOT EXISTS message_archives
            (id INTEGER PRIMARY KEY AUTOINCREMENT,
            origin_id INTEGER NOT NULL DEFAULT 0,
            username TEXT NOT NULL DEFAULT '',
            session_id TEXT NOT NULL DEFAULT 'default',
            role TEXT NOT NULL DEFAULT '',
            content TEXT NOT NULL DEFAULT '',
            employee_id INTEGER NOT NULL DEFAULT 0,
            employee_name TEXT NOT NULL DEFAULT '',
            is_partial INTEGER NOT NULL DEFAULT 0,
            origin_created_at TEXT NOT NULL DEFAULT '',
            archived_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')))''')
        conn.execute('''CREATE INDEX IF NOT EXISTS idx_message_archives_username ON message_archives (username)''')
        # 存量库补种「系统运维 / 定时任务」菜单 + 预置内置运维任务（按 name 幂等）
        _seed_task_menu(conn)
        _seed_default_tasks(conn)

        # ---------------- 通知配置（成员 E：Web 页面在线配置邮件/QQ） ----------------
        conn.execute('''CREATE TABLE IF NOT EXISTS system_settings
            (key TEXT NOT NULL PRIMARY KEY,
            value TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')))''')
        # 存量库补种「系统运维 / 通知配置」菜单
        _seed_notify_menu(conn)

        # ---------------- 会话归档页面（成员 E：message_archives 追溯） ----------------
        # 存量库补种「系统运维 / 会话归档」菜单
        _seed_archive_menu(conn)

        # ---------------- 对话记录管理 / 临时会话查询（成员 E） ----------------
        _seed_messages_menu(conn)
        _seed_sessions_menu(conn)

        # ---------------- 成员 D：前台用户端增强（任务2） ----------------
        # users 补列：昵称/头像（用户中心展示字段，老库老账号默认空串，不影响登录）
        _add_column_if_missing(conn, 'users', "nickname TEXT NOT NULL DEFAULT ''")
        _add_column_if_missing(conn, 'users', "avatar TEXT NOT NULL DEFAULT ''")

        # @音乐内置曲库：本地示例音频，全离线可播（文件在 static/music/，缺失时前端提示）
        conn.execute('''CREATE TABLE IF NOT EXISTS music_tracks
            (id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            artist TEXT NOT NULL DEFAULT '',
            style TEXT NOT NULL DEFAULT '',
            tags TEXT NOT NULL DEFAULT '',
            file TEXT NOT NULL,
            duration INTEGER NOT NULL DEFAULT 0,
            play_count INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
            UNIQUE(title, artist))''')
        _seed_music_tracks(conn)

        # 智能问数报告历史：每次问数落一条，report 存 JSON 字符串（按用户隔离查询）
        conn.execute('''CREATE TABLE IF NOT EXISTS qa_reports
            (id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            question TEXT NOT NULL,
            employee_id INTEGER NOT NULL DEFAULT 0,
            employee_name TEXT NOT NULL DEFAULT '',
            report TEXT NOT NULL DEFAULT '',
            source TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')))''')
        conn.execute('''CREATE INDEX IF NOT EXISTS idx_qa_reports_username ON qa_reports (username)''')