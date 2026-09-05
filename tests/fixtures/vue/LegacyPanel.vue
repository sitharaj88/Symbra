<template>
  <section>
    <UserCard :user="user" />
  </section>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import UserCard from './UserCard.vue';

export default defineComponent({
  name: 'LegacyPanel',
  components: { UserCard },
  props: {
    title: String,
    count: { type: Number, required: true },
    items: Array,
  },
  emits: ['refresh'],
  methods: {
    refresh(): void {
      this.$emit('refresh');
    },
  },
});
</script>
