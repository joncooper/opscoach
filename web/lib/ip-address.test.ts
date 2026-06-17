import assert from "node:assert/strict";
import test from "node:test";
import {
  isPrivateOrUnroutableIp,
  isPublicRoutableIp,
  learnerSshHost,
} from "./ip-address";

test("treats RFC1918 and link-local addresses as private", () => {
  assert.equal(isPrivateOrUnroutableIp("10.0.11.125"), true);
  assert.equal(isPrivateOrUnroutableIp("172.16.0.1"), true);
  assert.equal(isPrivateOrUnroutableIp("192.168.1.1"), true);
  assert.equal(isPrivateOrUnroutableIp("127.0.0.1"), true);
  assert.equal(isPrivateOrUnroutableIp("169.254.169.254"), true);
});

test("accepts public IPv4 addresses", () => {
  assert.equal(isPublicRoutableIp("3.14.249.88"), true);
  assert.equal(isPublicRoutableIp("8.8.8.8"), true);
});

test("hides private ssh hosts from learners", () => {
  assert.equal(learnerSshHost("10.0.0.213"), null);
  assert.equal(learnerSshHost("3.22.71.116"), "3.22.71.116");
});
