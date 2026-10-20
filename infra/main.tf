terraform {
  required_version = ">= 1.5, < 2.0"

  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 4.0"
    }
  }

  # El path se pasa en el init: -backend-config="path=$HOME/tfstate/facultad-hub.tfstate"
  # actions/checkout hace git clean -ffdx y se llevaría un estado ignorado dentro del repo.
  backend "local" {}
}

provider "docker" {
  host = var.docker_host
}

resource "docker_network" "app" {
  name = "facultad-hub-preprod"
}

resource "docker_volume" "db_data" {
  name = "facultad-hub-preprod-db-data"
}

resource "docker_volume" "vault" {
  name = "facultad-hub-preprod-vault"
}

resource "docker_volume" "datos" {
  name = "facultad-hub-preprod-datos"
}

resource "docker_image" "postgres" {
  name         = "postgres:16-alpine"
  keep_locally = true
}

resource "docker_image" "api" {
  name         = "ghcr.io/agustindt/facultad-hub-backend:${var.image_tag}"
  platform     = "linux/amd64"
  keep_locally = true
}

resource "docker_image" "front" {
  name         = "ghcr.io/agustindt/facultad-hub-frontend:${var.image_tag}"
  platform     = "linux/amd64"
  keep_locally = true
}

resource "docker_container" "db" {
  name    = "facultad-hub-preprod-db"
  image   = docker_image.postgres.image_id
  restart = "unless-stopped"

  env = [
    "POSTGRES_DB=hub",
    "POSTGRES_USER=hub",
    "POSTGRES_PASSWORD=${var.db_password}",
  ]

  networks_advanced {
    name = docker_network.app.name
  }

  volumes {
    volume_name    = docker_volume.db_data.name
    container_path = "/var/lib/postgresql/data"
  }

  healthcheck {
    test         = ["CMD-SHELL", "pg_isready -U hub -d hub"]
    interval     = "5s"
    timeout      = "3s"
    retries      = 10
    start_period = "10s"
  }
}

resource "docker_container" "api" {
  name    = "facultad-hub-preprod-api"
  image   = docker_image.api.image_id
  restart = "unless-stopped"

  env = [
    "DATABASE_URL=postgres://hub:${var.db_password}@${docker_container.db.name}:5432/hub",
    "VAULT_DIR=/vault",
    "DATA_DIR=/app/datos",
    "HOST=0.0.0.0",
    "PORT=4177",
  ]

  networks_advanced {
    name = docker_network.app.name
  }

  volumes {
    volume_name    = docker_volume.vault.name
    container_path = "/vault"
  }

  volumes {
    volume_name    = docker_volume.datos.name
    container_path = "/app/datos"
  }

  ports {
    internal = 4177
    external = 8090
  }

  healthcheck {
    test         = ["CMD", "node", "-e", "fetch('http://127.0.0.1:4177/api/vivo').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
    interval     = "10s"
    timeout      = "5s"
    retries      = 12
    start_period = "40s"
  }

  depends_on = [docker_container.db]
}

resource "docker_container" "front" {
  name    = "facultad-hub-preprod-front"
  image   = docker_image.front.image_id
  restart = "unless-stopped"

  env = [
    "BACKEND_URL=http://${docker_container.api.name}:4177",
  ]

  networks_advanced {
    name = docker_network.app.name
  }

  ports {
    internal = 80
    external = 3010
  }

  depends_on = [docker_container.api]
}
