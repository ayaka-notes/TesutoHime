"""Create (or promote) a super-admin user.

Usage (inside the web container):

    docker compose exec web python -m scripts.create_admin

Requires the DB environment variable to point at the database.
"""
import sys
from getpass import getpass
from os import environ

import sqlalchemy as sa
from argon2 import PasswordHasher
from sqlalchemy.orm import Session

from commons.models import User

# web/const.py: Privilege.SUPER
SUPER_ADMIN = 2


def main() -> None:
    db_url = environ.get('DB')
    if not db_url:
        print('error: the DB environment variable is not set.')
        sys.exit(1)

    username = input('Username: ').strip()
    if not username:
        print('error: username is required.')
        sys.exit(1)
    student_id = input('Student ID [%s]: ' % username).strip() or username
    friendly_name = input('Friendly name [%s]: ' % username).strip() or username
    password = getpass('Password: ')
    if not password:
        print('error: password is required.')
        sys.exit(1)
    if password != getpass('Confirm password: '):
        print('error: passwords do not match.')
        sys.exit(1)

    hashed = PasswordHasher().hash(password)
    engine = sa.create_engine(db_url)
    with Session(engine) as session:
        user = session.scalar(sa.select(User).where(User.username == username))
        if user is not None:
            user.password = hashed
            user.privilege = SUPER_ADMIN
            action = 'promoted to super admin (password reset)'
        else:
            user = User(username=username, student_id=student_id,
                        friendly_name=friendly_name, password=hashed,
                        privilege=SUPER_ADMIN)
            session.add(user)
            action = 'created as super admin'
        session.commit()
        print('User "%s" %s.' % (username, action))


if __name__ == '__main__':
    main()
