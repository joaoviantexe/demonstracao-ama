#!/usr/bin/env bash
# Uso: supabase-local.sh <args do supabase CLI>   (ex.: db reset | status -o env)
# Roda o Supabase CLI no diretório do repositório usando as imagens do Docker Hub.
export SUPABASE_INTERNAL_IMAGE_REGISTRY=docker.io
cd "$(dirname "$0")/.." && exec npx --yes supabase@2.120.0 "$@"
