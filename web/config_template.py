class DatabaseConfig:
    # 数据库地址, 一般替换 username 与 database 即可
    url = 'postgresql+psycopg2://username@/database'

    # 经过多少秒后，一个数据库连接将被 sqlalchemy 连接池回收。
    # 由于 mysql 服务端通常对一个连接的最长时长有限制（默认是 28800 秒），
    # 我们需要让 sqlalchemy 连接池在此之前主动作废这些已经过去很久的连接。
    # 参考 https://docs.sqlalchemy.org/en/14/core/engines.html#sqlalchemy.create_engine.params.pool_recycle
    connection_pool_recycle = 7200

class RedisConfig:
    connection = {
        'host': 'localhost',
        'port': 6379,
        'username': 'default',
        'password': 'Progynova',
        'db': 0,
    }
    prefix = 'web:'


class S3Config:
    public_url = 'https://acm.sjtu.edu.cn/OnlineJudge/'
    class Connections:
        public = {
            'endpoint_url': 'http://localhost:9000/',
            'aws_access_key_id': 'xxxxxxxxxxxxxxxx',
            'aws_secret_access_key': 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        }
        internal = {
            'endpoint_url': 'http://localhost:9000/',
            'aws_access_key_id': 'xxxxxxxxxxxxxxxx',
            'aws_secret_access_key': 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        }
    class Buckets:
        problems = 'oj-problems'
        submissions = 'oj-submissions'
        images = 'oj-images'
        attachments = 'oj-attachments'
        proctoring = 'oj-proctoring'


class LoginConfig:                        #登录过期时间，单位s
    Login_Life_Time = 24 * 60 * 60 * 60

class WebConfig:
    Problems_Each_Page = 20               #题库界面每页显示多少题目
    Block_Register = False                #暂停OJ注册
    Contests_Each_Page = 20               #比赛页面每页显示多少比赛
    Courses_Each_Page = 20

class NewsConfig:
    link = 'https://acm.sjtu.edu.cn/OnlineJudge/blog/'
    feed = 'https://acm.sjtu.edu.cn/OnlineJudge/blog/index.json'

class SchedulerConfig:
    base_url = 'http://localhost:5100'
    auth = 'Bearer xxxxxxxxxxxxxxxx'

class CustomRunConfig:
    # Base URL of the judger's custom-run service (web IDE "self-test").
    base_url = 'http://localhost:5200'


class ProctorConfig:
    # Base URL of the proctor2 aggregation service. Browsers POST media
    # chunks straight to this host; web/web.py only handles control plane
    # (start/end/event/finalize). For local dev both web and proctor2 run
    # on the host machine.
    base_url = 'http://localhost:5300'
    # Public URL the browser uses to reach proctor2 — must match the host
    # the student's machine actually resolves; in production this usually
    # routes through the same reverse-proxy as /OnlineJudge/.
    public_url = 'http://localhost:5300'
    # Shared secret used by web -> proctor2 finalize/cleanup calls. The
    # browser-facing endpoints authenticate via a per-session token issued
    # by the web side at session start.
    internal_auth = 'Bearer oj-internal-secret'


class LiveKitConfig:
    """LiveKit SFU coordinates. Browsers connect to ``url`` (ws:// or
    wss:// in production); the web server signs short-lived JWTs with
    ``api_key`` + ``api_secret`` so each session can publish/subscribe
    within its contest's room. Rotate the secret on every deploy.
    """
    url = 'ws://localhost:7880'
    api_key = 'oj_proctor_key'
    api_secret = 'oj_proctor_secret_change_me_before_production_xxxxxxxxxxxxxxxxxxxx'

class JudgeConfig:
    Judge_Each_Page = 15                  #评测详情界面每页显示多少题目

class ProblemConfig:
    Max_Code_Length = 16384 * 8           #代码提交最多接受长度上限
                                          #这里为后端限制，请注意在前端js中还有限制，请一并修改


class QuizTempDataConfig:
    cache_dir = '/var/cache/oj/web'       #quiz_cache_dir，用于解压存放填选临时文件的本地目录

class LogConfig:
    log_dir = '/var/log/oj/web'

class JAccountConfig:
    CLIENT_ID = 'YOUR JACCOUNT CLIENT ID'
    CLIENT_SECRET = 'YOUR JACCOUNT CLIENT SECRET'
    AUTHORIZATION_BASE_URL = 'https://jaccount.sjtu.edu.cn/oauth2/authorize'
    TOKEN_URL = 'https://jaccount.sjtu.edu.cn/oauth2/token'
    LOGOUT_URL = 'https://jaccount.sjtu.edu.cn/oauth2/logout'
    PROFILE_URL = 'https://api.sjtu.edu.cn/v1/me/profile'
