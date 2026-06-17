# AWS CLI Quick Reference

This file is a syntax aid, not a solution guide. The lab brief defines the target state. Use this reference when you need to remember AWS CLI command shape.

## Basic Shape

```bash
aws <service> <operation> [options]
```

Common operation prefixes:

- `list-*`: enumerate resources
- `describe-*`: inspect EC2-style resources
- `get-*`: inspect one configuration object
- `put-*`: create or replace a configuration object
- `modify-*`: change a resource setting
- `revoke-*`: remove an existing permission or rule

## Getting Help

```bash
aws help
aws <service> help
aws <service> <operation> help
```

Tab completion is enabled:

```bash
aws ec2 describe-<TAB>
aws s3api get-bucket-<TAB>
echo $RE<TAB>
```

## Resource Variables

The lab shell loads assigned resource variables from `resource-map.env`.

```bash
env | grep -E 'RESEARCH|SECURITY|LAUNCH|TRAIL|ALARM|AUDIT'
cat resource-map.env
```

## JSON Input Files

Some AWS operations take structured JSON. Use `file://` when passing a local JSON file:

```bash
aws some-service some-operation --some-input file://templates/example.json
```

Inspect or edit templates with:

```bash
jq . templates/example.json
nano templates/example.json
```

## Reading Output

Use `--query` for AWS CLI filtering:

```bash
aws some-service describe-things --query 'Things[0]'
```

Use `jq` for JSON exploration:

```bash
aws some-service describe-things | jq .
aws some-service describe-things | jq '.Things[] | keys'
```

## Errors

Common meanings:

- `AccessDenied`: your lab role is not allowed to do that action.
- `NoSuch...` / `NotFound`: the resource or config may not exist.
- `ValidationError`: the command shape or input fields are wrong.
- Empty JSON `{}`: the config may be unset.

Treat errors as evidence, but verify whether the command is relevant to the target state.
