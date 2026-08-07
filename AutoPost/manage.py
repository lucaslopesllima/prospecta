#!/usr/bin/env python3
"""CLI de administração (sem registro público, sem recuperação por e-mail).

Comandos:
    python manage.py gen-keys
    python manage.py init-db
    python manage.py create-user --nome "Fulano" --email f@x.com [--senha S] [--timezone TZ]
    python manage.py reset-password --email f@x.com [--senha S]
    python manage.py list-users
"""
import argparse
import getpass
import sys


def cmd_gen_keys(_args) -> None:
    import secrets

    from cryptography.fernet import Fernet

    print("Adicione ao seu .env:")
    print(f"FERNET_KEY={Fernet.generate_key().decode()}")
    print(f"SESSION_SECRET={secrets.token_urlsafe(48)}")


def _get_password(args) -> str:
    if args.senha:
        return args.senha
    senha = getpass.getpass("Senha: ")
    confirma = getpass.getpass("Confirme: ")
    if senha != confirma:
        sys.exit("senhas não conferem")
    if len(senha) < 8:
        sys.exit("senha deve ter ao menos 8 caracteres")
    return senha


def cmd_init_db(_args) -> None:
    from app import db

    conn = db.connect()
    db.init_db(conn)
    conn.close()
    print("banco inicializado")


def cmd_create_user(args) -> None:
    from app import auth, db

    senha = _get_password(args)
    conn = db.connect()
    db.init_db(conn)
    if db.get_user_by_email(conn, args.email):
        sys.exit(f"já existe usuário com e-mail {args.email}")
    user_id = db.create_tenant_with_user(
        conn, args.nome, args.email, auth.hash_password(senha), args.timezone
    )
    user = db.get_user(conn, user_id)
    conn.close()
    print(f"usuário criado: id={user_id} tenant={user['tenant_id']} email={args.email}")


def cmd_reset_password(args) -> None:
    from app import auth, db

    senha = _get_password(args)
    conn = db.connect()
    if not db.set_password(conn, args.email, auth.hash_password(senha)):
        sys.exit(f"usuário {args.email} não encontrado")
    conn.close()
    print("senha atualizada")


def cmd_list_users(_args) -> None:
    from app import db

    conn = db.connect()
    db.init_db(conn)
    for u in db.list_users(conn):
        print(f"id={u['id']} tenant={u['tenant_id']} {u['email']} "
              f"({u['nome']}) last_login={u['last_login'] or '-'}")
    conn.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Administração do AutoPost")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("gen-keys").set_defaults(fn=cmd_gen_keys)
    sub.add_parser("init-db").set_defaults(fn=cmd_init_db)

    p = sub.add_parser("create-user")
    p.add_argument("--nome", required=True)
    p.add_argument("--email", required=True)
    p.add_argument("--senha")
    p.add_argument("--timezone", default="America/Sao_Paulo")
    p.set_defaults(fn=cmd_create_user)

    p = sub.add_parser("reset-password")
    p.add_argument("--email", required=True)
    p.add_argument("--senha")
    p.set_defaults(fn=cmd_reset_password)

    sub.add_parser("list-users").set_defaults(fn=cmd_list_users)

    args = parser.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
