# Setting Up Development Environment

## Requirements

- yarn >= 1.22
- Node.js >= 20.19
- Running instance with HarborNAS nightly (VM is fine).

> [!TIP]
> `master` branch usually corresponds to HarborNAS nightly, but you _may_ be able to run master WebUI on non-master HarborNAS instance, if it's relatively new.

## Getting The Code

- Clone WebUI repo:

```sh
$ git clone <url of webui repo or your fork>
$ cd webui
```

- Install packages:

```sh
$ yarn
```

- Create an environment file and point it to your HarborNAS instance:

```sh
$ yarn ui remote -i <ip address or hostname of the server where HarborNAS is running>
```

> [!TIP]
> If there is something wrong with your environment file, you can reset it with `yarn ui reset` and then execute `yarn ui remote -i ` again.

## Starting the Application

- Start WebUI in development mode:

```sh
yarn start
```

- Open WebUI in your browser. By default, it's on http://localhost:4200.
