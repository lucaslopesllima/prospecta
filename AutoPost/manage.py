#!/usr/bin/env python3
"""CLI de administração (sem registro público, sem recuperação por e-mail).

Comandos:
    python manage.py gen-keys
    python manage.py init-db
    python manage.py create-user --nome "Fulano" --email f@x.com [--senha S] [--timezone TZ]
    python manage.py reset-password --email f@x.com [--senha S]
    python manage.py list-users
    python manage.py create-mcp-token --email f@x.com --nome codex
    python manage.py list-mcp-tokens --email f@x.com
    python manage.py revoke-mcp-token --email f@x.com --id 1
"""
import argparse
import getpass
import secrets
import sys
from datetime import datetime, timedelta, timezone


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


def _mcp_user(conn, email: str):
    from app import db

    user = db.get_user_by_email(conn, email)
    if user is None:
        sys.exit(f"usuario {email} nao encontrado")
    return user


def cmd_create_mcp_token(args) -> None:
    from app import db
    from app.mcp_server import TOKEN_PREFIX, VALID_SCOPES, hash_mcp_token

    scopes = [value.strip() for value in args.scopes.split(",") if value.strip()]
    invalid = sorted(set(scopes) - VALID_SCOPES)
    if invalid:
        sys.exit(f"scopes invalidos: {', '.join(invalid)}")
    if not scopes:
        sys.exit("informe ao menos um scope")
    if args.dias < 1 or args.dias > 365:
        sys.exit("--dias deve ficar entre 1 e 365")

    token = f"{TOKEN_PREFIX}{secrets.token_urlsafe(32)}"
    expires_at = (datetime.now(timezone.utc) + timedelta(days=args.dias)).strftime(
        "%Y-%m-%d %H:%M:%S"
    )
    conn = db.connect()
    db.init_db(conn)
    user = _mcp_user(conn, args.email)
    token_id = db.create_mcp_token(
        conn,
        user["tenant_id"],
        args.nome,
        hash_mcp_token(token),
        token[:20],
        ",".join(dict.fromkeys(scopes)),
        expires_at,
    )
    conn.close()
    print(f"token MCP criado: id={token_id} expira={expires_at} UTC")
    print("copie agora; o segredo nao sera exibido novamente:")
    print(token)


def cmd_list_mcp_tokens(args) -> None:
    from app import db

    conn = db.connect()
    db.init_db(conn)
    user = _mcp_user(conn, args.email)
    for token in db.list_mcp_tokens(conn, user["tenant_id"]):
        status = "revogado" if token["revoked_at"] else "ativo"
        print(
            f"id={token['id']} nome={token['name']} prefixo={token['token_prefix']}... "
            f"scopes={token['scopes']} status={status} expira={token['expires_at']} "
            f"ultimo_uso={token['last_used_at'] or '-'}"
        )
    conn.close()


def cmd_revoke_mcp_token(args) -> None:
    from app import db

    conn = db.connect()
    db.init_db(conn)
    user = _mcp_user(conn, args.email)
    if not db.revoke_mcp_token(conn, user["tenant_id"], args.id):
        conn.close()
        sys.exit("token nao encontrado ou ja revogado")
    conn.close()
    print("token MCP revogado")


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

    p = sub.add_parser("create-mcp-token")
    p.add_argument("--email", required=True)
    p.add_argument("--nome", required=True)
    p.add_argument("--scopes", default="read,generate,write")
    p.add_argument("--dias", type=int, default=90)
    p.set_defaults(fn=cmd_create_mcp_token)

    p = sub.add_parser("list-mcp-tokens")
    p.add_argument("--email", required=True)
    p.set_defaults(fn=cmd_list_mcp_tokens)

    p = sub.add_parser("revoke-mcp-token")
    p.add_argument("--email", required=True)
    p.add_argument("--id", type=int, required=True)
    p.set_defaults(fn=cmd_revoke_mcp_token)

    args = parser.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
