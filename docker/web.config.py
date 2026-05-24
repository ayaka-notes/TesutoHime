"""TesutoHime Web configuration for Docker deployment.

This file is copied to web/config.py inside the image. All deployment-specific
values are read from environment variables (set in docker-compose.yml) so that
the image itself contains no secrets.
"""
import os


def _env(key: str, default: str) -> str:
    value = os.environ.get(key)
    return value if value not in (None, '') else default


class DatabaseConfig:
    url = _env('DB', 'postgresql+psycopg2://oj:oj_password@postgres:5432/oj')
    connection_pool_recycle = 7200


class RedisConfig:
    connection = {
        'host': _env('REDIS_HOST', 'redis'),
        'port': int(_env('REDIS_PORT', '6379')),
        'db': int(_env('REDIS_WEB_DB', '0')),
    }
    prefix = 'web:'


class S3Config:
    # Base URL the browser uses to reach S3 (MinIO) objects.
    public_url = _env('S3_PUBLIC_URL', 'http://localhost:9000/')

    class Connections:
        # Used to generate presigned URLs handed to the browser; the endpoint
        # host must match what the browser actually connects to, otherwise the
        # request signature will not validate.
        public = {
            'endpoint_url': _env('S3_PUBLIC_ENDPOINT', 'http://localhost:9000/'),
            'aws_access_key_id': _env('S3_ACCESS_KEY', 'minioadmin'),
            'aws_secret_access_key': _env('S3_SECRET_KEY', 'minioadmin'),
        }
        # Used by the web server itself (in-cluster) to download files.
        internal = {
            'endpoint_url': _env('S3_INTERNAL_ENDPOINT', 'http://minio:9000/'),
            'aws_access_key_id': _env('S3_ACCESS_KEY', 'minioadmin'),
            'aws_secret_access_key': _env('S3_SECRET_KEY', 'minioadmin'),
        }

    class Buckets:
        problems = 'oj-problems'
        submissions = 'oj-submissions'
        images = 'oj-images'
        attachments = 'oj-attachments'


class LoginConfig:
    Login_Life_Time = 24 * 60 * 60 * 60


class WebConfig:
    Problems_Each_Page = 20
    Block_Register = False
    Contests_Each_Page = 20
    Courses_Each_Page = 20


class NewsConfig:
    link = 'https://acm.sjtu.edu.cn/OnlineJudge/blog/'
    feed = 'https://acm.sjtu.edu.cn/OnlineJudge/blog/index.json'


class SchedulerConfig:
    base_url = _env('SCHEDULER_BASE_URL', 'http://scheduler:5100/')
    auth = _env('SCHEDULER_AUTH', 'Bearer oj-internal-secret')


class CustomRunConfig:
    # Base URL of the judger's custom-run service (the web IDE "self-test").
    base_url = _env('CUSTOM_RUN_URL', 'http://judger:5200/')


class JudgeConfig:
    Judge_Each_Page = 15


class ProblemConfig:
    Max_Code_Length = 16384 * 8


class QuizTempDataConfig:
    cache_dir = _env('QUIZ_CACHE_DIR', '/var/cache/oj/web')


class LogConfig:
    log_dir = _env('WEB_LOG_DIR', '/var/log/oj/web')


class JAccountConfig:
    CLIENT_ID = _env('JACCOUNT_CLIENT_ID', 'YOUR JACCOUNT CLIENT ID')
    CLIENT_SECRET = _env('JACCOUNT_CLIENT_SECRET', 'YOUR JACCOUNT CLIENT SECRET')
    AUTHORIZATION_BASE_URL = 'https://jaccount.sjtu.edu.cn/oauth2/authorize'
    TOKEN_URL = 'https://jaccount.sjtu.edu.cn/oauth2/token'
    LOGOUT_URL = 'https://jaccount.sjtu.edu.cn/oauth2/logout'
    PROFILE_URL = 'https://api.sjtu.edu.cn/v1/me/profile'
