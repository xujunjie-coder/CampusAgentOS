"""Small live smoke run in a separate SQLite DB, never the application's real DB.

Run: venv\Scripts\python.exe tools/verify_qq_channel.py
Results: outputs/qq-channel-validation.json (coverage/counts only).
"""
import json
import os
from pathlib import Path
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def main():
    output = ROOT / 'outputs'
    output.mkdir(exist_ok=True)
    db = Path(tempfile.mkdtemp(prefix='qq-channel-')) / 'validation.db'
    os.environ.update(DB_DRIVER='sqlite', DB_PATH=str(db), SCHEDULER_ENABLED='0')
    from app.models.db import init_db
    from app.models import qq_channel as repo
    from app.services.qq_channel_service import start_run
    init_db()
    run_id = start_run({'channel':'CWNUpindao', 'keywords':'食堂，热水，洗衣机',
                        'max_posts':12,'max_comments':60,'max_scrolls':12}, 'live-validation')
    previous = None
    while True:
        run = repo.get_run(run_id)
        label = (run['status'],run['message'])
        if label != previous:
            print(json.dumps({'status':run['status'],'message':run['message'],
                              'progress':run['progress']},ensure_ascii=False),flush=True)
            previous = label
        if run['status'] not in ('queued','running','cancelling'):
            count = repo.items(run_id)['total']
            report = {'run':run,'saved_matches':count,'validation_db':str(db)}
            (output / 'qq-channel-validation.json').write_text(
                json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
            if run['status'] != 'finished' or not run['progress'].get('scanned_posts'):
                raise SystemExit(1)
            print('LIVE_VALIDATION_OK',count,flush=True)
            break
        time.sleep(1)


if __name__ == '__main__':
    main()
