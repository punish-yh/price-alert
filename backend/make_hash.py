"""生成 ADMIN_PASSWORD_HASH：python -m backend.make_hash"""
import getpass

import bcrypt

if __name__ == "__main__":
    pwd = getpass.getpass("输入管理员密码: ")
    pwd2 = getpass.getpass("再次输入确认: ")
    if pwd != pwd2:
        raise SystemExit("两次输入不一致")
    if len(pwd) < 10:
        raise SystemExit("密码至少 10 位，请使用强密码")
    print("\n将下面这行写入 backend/.env：")
    print(f"ADMIN_PASSWORD_HASH={bcrypt.hashpw(pwd.encode(), bcrypt.gensalt(rounds=12)).decode()}")
