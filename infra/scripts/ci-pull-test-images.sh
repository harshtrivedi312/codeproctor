#!/bin/sh
# Pulls the images the CI tests start (Testcontainers Postgres and Redis, the backup restore drill)
# from public mirrors that need no credentials, by digest, and tags them with the plain names the
# tests use. Testcontainers then finds the image locally and does not pull from Docker Hub, whose
# unauthenticated pull limit ("toomanyrequests") fails runs when many PRs build at once.
#
# No Docker Hub token is used or needed: a credential would go through the owner (ADR 0009, C-63).
# Both mirrors serve the same content, so the digest is the same on either one. To move to a newer
# image, change the tag in the tests and the digest here together (infra/scripts/ci-pull-test-images.test.mjs
# fails if they drift).
set -eu

pull_one() {
  name=$1
  tag=$2
  digest=$3
  for registry in mirror.gcr.io/library public.ecr.aws/docker/library; do
    attempt=1
    while [ "$attempt" -le 3 ]; do
      if docker pull -q "$registry/$name@$digest" >/dev/null 2>&1; then
        docker tag "$registry/$name@$digest" "$name:$tag"
        echo "pulled $name:$tag ($digest) from $registry"
        return 0
      fi
      attempt=$((attempt + 1))
      sleep $((attempt * 5))
    done
  done
  echo "could not pull $name:$tag from any mirror" >&2
  return 1
}

pull_one postgres 16 sha256:ca0bd484cb98bf4b24eb1010e73fb3fcbd6714d240fbc1a10eea5b7dbecb641d
pull_one redis 8.8 sha256:eb1aa641bc5380ed14442398e45a5a51aeaaac919fab811e4f134eb77c71dd2d
