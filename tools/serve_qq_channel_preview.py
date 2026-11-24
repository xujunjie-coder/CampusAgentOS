"""Serve an isolated local UI preview using the latest completed live smoke data.

Never uses production data/accounts. Login: qq-preview / preview-only-20261123.
"""
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def main():
    report = json.loads((ROOT / 'outputs/qq-channel-validation.json').read_text(encoding='utf-8'))
    db = Path(tempfile.mkdtemp(prefix='qq-channel-ui-')) / 'preview.db'
    shutil.copyfile(report['validation_db'], db)
    os.environ.update(DB_DRIVER='sqlite', DB_PATH=str(db), SCHEDULER_ENABLED='0', DEBUG='0',
                      COOKIE_SECRET='isolated-qq-preview-cookie-secret', XSRF_ENABLED='1', APP_PORT='10087')
    from app.application import make_app
    from app.models.user import UserRepository
    import tornado.ioloop
    application = make_app()
    UserRepository.create_user('qq-preview', 'preview-only-20261123', 'admin')
    application.listen(10087, address='127.0.0.1')
    print('QQ_UI_PREVIEW http://127.0.0.1:10087/collect',flush=True)
    tornado.ioloop.IOLoop.current().start()


if __name__ == '__main__':
    main()
