<template>
  <div class="card">
    <Avatar :src="user.avatar" />
    <user-badge :level="user.level" />
    <p>{{ label }}</p>
    <button @click="onClick">go</button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import Avatar from './Avatar.vue';
import UserBadge from './UserBadge.vue';
import { formatName } from '../utils/format';

interface User {
  name: string;
  level: number;
}

const props = defineProps<{
  user: User;
  compact?: boolean;
}>();

const emit = defineEmits(['select', 'close']);

const count = ref(0);

/** Display label for the card. */
const label = computed(() => formatName(props.user.name));

function onClick(): void {
  count.value += 1;
  emit('select', props.user);
}
</script>

<style scoped>
.card { display: flex; }
</style>
